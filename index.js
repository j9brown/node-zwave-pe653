const { program } = require('commander');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');
const mqtt = require('mqtt');
const { crc16update, crc32firmware } = require('./crc');

// The Intermatic manufacturer ID for ZWave products.
const manufacturerId = 0x0005;
const productType = 0x5045; // 'PE'

function getProductId(nodeInfo) {
    if (nodeInfo.manufacturerId === manufacturerId &&
            nodeInfo.productType === productType) {
        if (nodeInfo.productId === 0x0653) return "PE0653";
        if (nodeInfo.productId === 0x0953) return "PE0953";
    }
    return null;
}

function actualFirmwareCRC(blob) {
    return crc32firmware(blob.subarray(0, blob.length - 4));
}

function expectedFirmwareCRC(blob) {
    return (blob[blob.length - 1] |
            (blob[blob.length - 2] << 8) |
            (blob[blob.length - 3] << 16) |
            (blob[blob.length - 4] << 24)) >>> 0;
}

function checkFirmwareCRC(blob) {
    // This check doesn't work.  We're probably using the wrong algorithm.
    if (false) {
        const actualCRC = actualFirmwareCRC(blob);
        const expectedCRC = expectedFirmwareCRC(blob);
        console.log(`!! CRC check, expected 0x${expectedCRC.toString(16)}, actual 0x${actualCRC.toString(16)}`)
        return actualCRC === expectedCRC;
    }
    return true;
}

function sha256(blob) {
    let hash = crypto.createHash('sha256');
    hash.update(blob);
    return hash.digest('hex');
}

function createFirmwareStream(file) {
    const key = 'gbUst8Ce8Cp4bkPw';
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
    return fs.createReadStream(file).pipe(decipher);
}

async function readFirmwareArchive(file, createIhexStream, createBinStream) {
    const maxBlobLength = 128 * 1024;
    const reader = readline.createInterface({
            input: createFirmwareStream(file),
            crlfDelay: Infinity
        });
    const archive = {
        version: 'unknown',
        products: {}
    };
    let productId = undefined;
    let blob = undefined;
    let extendedSegmentAddress = 0;
    let maxAddress = 0;
    let hexStream = undefined;
    reader.on('line', (line) => {
        if (line.startsWith(':')) {
            if (line.length % 2 !== 1)
                throw new Error('Record does not have an even number of digits');
            if (productId === undefined)
                throw new Error('Missing product metadata while decoding blob');

            const record = new Uint8Array((line.length - 1) / 2);
            let checksum = 0;
            for (let i = 0; i < record.length; i++) {
                byte = parseInt(line.substring(i * 2 + 1, i * 2 + 3), 16);
                record[i] = byte;
                checksum += byte;
            }
            checksum &= 255;
            if (checksum !== 0)
                throw new Error('Record does not have a zero checksum');

            if (blob === undefined) {
                blob = new Uint8Array(maxBlobLength).fill(0xff);
                extendedSegmentAddress = 0;
                maxAddress = 0;
                if (createIhexStream)
                    hexStream = createIhexStream(productId);
            }
            if (hexStream) {
                hexStream.write(line);
                hexStream.write('\n');
            }
    
            // [0]       length of record data
            // [1..2]    record offset
            // [3]       record type
            // [4..len]  record data
            // [len]     record checksum
            const dataLength = record[0];
            if (dataLength + 4 + 1 !== record.length)
                throw new Error('Record data length is invalid');
            const offset = (record[1] << 8) | record[2];
            const recordType = record[3];
            switch (recordType) {
                case 0: // data record
                    if (dataLength !== 16)
                        throw new Error('Data record malformed');
                    let startAddress = (extendedSegmentAddress << 4) + offset;
                    let endAddress = startAddress + dataLength;
                    if (endAddress > maxBlobLength)
                        throw new Error('Data record offset out of range');
                    if (endAddress > maxAddress)
                        maxAddress = endAddress;
                    blob.set(record.subarray(4, 4 + dataLength), startAddress);
                    break;
                case 1: // EOF record
                    if (dataLength !== 0 || offset !== 0)
                        throw new Error('EOF record malformed');
                    if (archive.products[productId].blob !== undefined)
                        throw new Error('Encountered a second blob for the same product');

                    if (hexStream) {
                        hexStream.close();
                        hexStream = undefined;
                    }
    
                    blob = blob.subarray(0, maxAddress);
                    if (createBinStream) {
                        const stream = createBinStream(productId);
                        if (stream) {
                            stream.write(blob);
                            stream.close();
                        }
                    }

                    let product = archive.products[productId];
                    product.blob = blob;
                    product.blobLength = blob.length;
                    product.blobHash = sha256(blob);
                    blob = undefined;
                    break;
                case 2: // extended segment address
                    if (dataLength !== 2 || offset !== 0)
                        throw new Error('Extended segment address record malformed');
                    extendedSegmentAddress = (record[4] << 8) | record[5];
                    break;
                case 3: // start segment address
                case 4: // extended linear address
                case 5: // start linear address
                default:
                    throw new Error(`Unsupported record type ${recordType}`);
            }
        } else {
            if (blob !== undefined)
                throw new Error('Encountered metadata while decoding a blob');
            let s = line.split('=');
            if (s.length == 4) {
                productId = s[0];
                archive.products[productId] = {
                    name: s[1],
                    version: s[2],
                    message: s[3]
                };
            } else if (archive.version === 'unknown') {
                archive.version = line;
            }
        }
    });
    await once(reader, 'close');
    return archive;
}

// Sends firmware to the device.
//
// The protocol consists of a bidirectional flow of messages from the updater to the
// device using the Zwave ManufacturerProprietary Command Class.
//
// Each packet consists of an 8-bit command code, an 8-bit packet type, a 16-bit
// little-endian sequence number, up to 32 bytes of data, and a 16-bit little-endian
// CRC of that data, depending on the packet type.
//
// The updater first sends a packet to start the transfer then waits
// for the device to request data blocks and sends the requested data until the
// transfer is done.  The updater then waits for the device to confirm whether the
// transfer completed successfully.  The device controls the rate at which data is
// requested and transferred and is responsible for incrementing the sequence number.
//
// Note that the sequence number never rolls over to zero during a transfer.
//
// start transfer:
//    send packet [CMD, START]
//
// on received packet [CMD, DATA_REQUEST, seq]:
//    if seq != last seq + 1 and seq != 0, ignore message
//    if seq * 32 >= data length, send packet [CMD, DONE, seq]
//    send packet [CMD, DATA, seq, up to 32 bytes of data starting at offset seq * 32, crc16 of packet]
//
// on received packet [CMD, DONE, seq]:
//    transfer succeeded
//    NOTE: It seems that these devices don't actually send a DONE packet at the end of
//          the transfer or it gets lost in transit although the firmware updater expects
//          to receive one.
//
// on received packet [CMD, CRC_ERROR, seq]:
//    transfer failed
//
// when no DATA_REQUEST packet is received for 10 seconds:
//    timeout, resend last packet
//
// unrecognized packets are ignored
const packetStart = 0;
const packetData = 2;
const packetDataRequest = 3;
const packetDone = 6;
const packetCRCError = 7;
const commandFirmwareTransfer = 42;
const maxTimeouts = 5;
const knownFirmwareSize = 116 * 1024;

class LogTransport {
    constructor(inner) {
        this._inner = inner;
    }

    async sendAndReceive(packet) {
        console.log(`>> SEND ${packet}`);
        const reply = await this._inner.sendAndReceive(packet);
        console.log(`<< RECV ${reply}`);
        return reply;
    }
}

class FakeTransport {
    constructor(debug) {
        this._nextSeq = 0;
        this._state = 'wait';
        this._debug = debug;
        this._blob = new Uint8Array(knownFirmwareSize);
    }

    sendAndReceive(packet) {
        // Throttle the responses to simulate communication delay (vaguely).
        const reply = this._handlePacket(Uint8Array.from(packet));
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(reply);
            }, 5);
        });
    }

    _handlePacket(packet) {
        if (packet.length < 2 || packet[0] !== commandFirmwareTransfer) return null;

        const type = packet[1];
        const seq = packet.length >= 4 ? packet[2] | (packet[3] << 8) : -1;
        switch (type) {
            case packetStart: {
                if (this._state !== 'wait') return null;

                if (this._debug)
                    console.log('!! START');
                this._state = 'transfer';
                this._nextSeq = 0;
                break;
            }
            case packetData: {
                if (this._state !== 'transfer' || this._nextSeq !== seq || packet.length < 6) return null;

                const data = packet.subarray(4, packet.length - 2);
                const crc = packet[packet.length - 2] | (packet[packet.length - 1] << 8);
                let check = 0;
                for (let i = 0; i < packet.length - 2; i++)
                    check = crc16update(check, packet[i]);
                if (this._debug)
                    console.log(`!! DATA(${packet.length}) seq ${seq} - ${data} - crc 0x${crc.toString(16)} (0x${check.toString(16)})`);
                if (check !== crc) return; // presumably the receiver ignores the packet to await a retransmit

                const offset = seq * 32;
                if (offset + data.length > this._blob.length) {
                    if (this._debug)
                        console.log(`!! Received blob too large`);
                    this._state = 'error';
                    break;
                }

                this._blob.set(data, seq * 32);
                this._nextSeq++;
                break;
            }
            case packetDone: {
                if (this._state !== 'transfer' || this._nextSeq !== seq || packet.length < 4) return null;

                if (this._debug)
                    console.log(`!! DONE ${seq}`);

                this._state = checkFirmwareCRC(this._blob) ? 'done' : 'error';
                break;
            }
        }

        switch (this._state) {
            case 'transfer':
                return [commandFirmwareTransfer, packetDataRequest,
                        this._nextSeq & 255, this._nextSeq >> 8];
            case 'error':
                return [commandFirmwareTransfer, packetCRCError,
                        this._nextSeq & 255, this._nextSeq >> 8];
            case 'done':
                // In practice, this packet seems to get lost in transit, so let's simulate that behavior.
                // It's ok either way.
                //return [commandFirmwareTransfer, packetDone,
                //        this._nextSeq & 255, this._nextSeq >> 8];
        }
        return null;
    }
}

class ZwaveJS2MqttServer {
    constructor(url, api, debug) {
        this._url = url;
        this._sendCommandCallTopic = api + '/sendCommand/set';
        this._sendCommandResultTopic = api + '/sendCommand';
        this._sendCommandResolve = null;
        this._driverFunctionCallTopic = api + '/driverFunction/set';
        this._driverFunctionResultTopic = api + '/driverFunction';
        this._driverFunctionResolve = null;
        this._debug = debug;
    }

    async connect() {
        this._client = mqtt.connect(this._url);

        this._client.on('close', () => {
            console.log('Disconnected from MQTT');
        });

        this._client.on('error', (error) => {
            console.log(`MQTT error: ${error}`);
        });

        this._client.on('message', (topic, message) => {
            if (topic === this._sendCommandResultTopic && this._sendCommandResolve) {
                this._sendCommandResolve(JSON.parse(message.toString()));
                this._sendCommandResolve = null;
            }
            if (topic === this._driverFunctionResultTopic && this._driverFunctionResolve) {
                this._driverFunctionResolve(JSON.parse(message.toString()));
                this._driverFunctionResolve = null;
            }
        });

        await once(this._client, 'connect');

        await this._subscribe(this._sendCommandResultTopic);
        await this._subscribe(this._driverFunctionResultTopic);
        console.log('Connected to Zwave2MQTT server via MQTT');
    }

    async disconnect() {
        await this._client.end();
    }

    getNodeInfo(nodeId) {
        return this._driverFunction(`
            const nodeId = ${nodeId};
            const node = driver.controller.nodes.get(nodeId);
            if (!node) return null;
            return {
                nodeId: node.id,
                name: node.name,
                location: node.location,
                firmwareVersion: node.firmwareVersion,
                manufacturerId: node.manufacturerId,
                productId: node.productId,
                productType: node.productType
            };
        `);
    }

    async sendAndReceive(nodeId, packet) {
        const result = await this._sendCommand(nodeId, 0, 0x91, "sendAndReceiveData", [
            manufacturerId,
            { type: "Buffer", data: Array.from(packet) }
        ]);
        if (result) {
            return Array.from(result.data.data);
        }
    }

    async _sendCommand(nodeId, endpoint, commandClass, method, args) {
        const call = JSON.stringify({ args: [
            { "nodeId": nodeId, "endpoint": endpoint, "commandClass": commandClass },
            method,
            args
        ]});
        await this._publish(this._sendCommandCallTopic, call);

        const response = await new Promise((resolve, reject) => {
            this._sendCommandResolve = resolve;
        });
        if (this._debug)
            console.dir(response);

        if (response.args[0].nodeId !== nodeId ||
            response.args[0].endpoint !== endpoint ||
            response.args[0].commandClass !== commandClass ||
            response.args[1] !== method)
            throw Error(`Send command call response mismatch`);
        if (!response.success)
            throw Error(`Send command call failed: ${response.message}`);
        return response.result;
    }

    async _driverFunction(code) {
        const call = JSON.stringify({ args: [ code ]});
        await this._publish(this._driverFunctionCallTopic, call);

        const response = await new Promise((resolve, reject) => {
            this._driverFunctionResolve = resolve;
        });
        if (this._debug)
            console.dir(response);

        if (response.args[0] !== code)
            throw Error('Driver function call response mismatch');
        if (!response.success)
            throw Error(`Driver function call failed: ${response.message}`);
        return response.result;
    }

    _publish (...args) {
        return new Promise((resolve, reject) => {
            this._client.publish(...args, (err, result) => {
                if (err) reject(err); else resolve(result);
            });
        });
    }

    _subscribe (...args) {
        return new Promise((resolve, reject) => {
            this._client.subscribe(...args, (err, result) => {
                if (err) reject(err); else resolve(result);
            });
        });
    }
}

class ZwaveJS2MqttTransport {
    constructor(server, nodeId) {
        this._server = server;
        this._nodeId = nodeId;
    }

    sendAndReceive(packet) {
        // call driver.sendCommand or driver.waitForCommand?
        return this._server.sendAndReceive(this._nodeId, packet);
    }
}

async function uploadFirmware(blob, transport) {
    let currentSeq = -1;
    let currentPacket = [commandFirmwareTransfer, packetStart];
    let timeouts = 0;
    let done = false;

    if (blob.length !== knownFirmwareSize) {
        console.error(`Incorrect firmware size, expected ${knownFirmwareSize}, got ${blob.length}`);
        return false;
    }

    if (!checkFirmwareCRC(blob)) {
        console.error(`Incorrect firmware CRC`);
        return false;
    }

    console.log('Starting firmware upload...');
    for (;;) {
        const reply = await transport.sendAndReceive(currentPacket);
        if (!reply) {
            timeouts++;
            if (timeouts < maxTimeouts) {
                console.log(`Timeout occurred, resending last packet (${timeouts}/${maxTimeouts})`);
                continue;
            }
            if (done) {
                console.log('All packets were sent but we did not receive final confirmation from the device!\n' +
                    'Assuming the firmware was successfully uploaded');
            } else {
                console.log('Upload failed due to timeout, giving up');
            }
            return false;
        }
        timeouts = 0;

        if (reply.length < 4) continue;
        if (reply[0] !== commandFirmwareTransfer) continue;
        const type = reply[1];
        const seq = reply[2] | (reply[3] << 8);
        switch (type) {
            case packetDataRequest: {
                if (seq !== currentSeq + 1) continue;
                currentSeq = seq;
                const offset = seq * 32;
                if (offset % 1024 === 0)
                    console.log(`Sending data (${offset}/${blob.length})`);
                if (offset < blob.length) {
                    const data = Array.from(blob.subarray(offset, Math.min(offset + 32, blob.length)));
                    currentPacket = [commandFirmwareTransfer, packetData, seq & 0xff, seq >> 8].concat(data);
                    let crc16 = 0;
                    currentPacket.forEach((byte) => { crc16 = crc16update(crc16, byte) });
                    currentPacket.push(crc16 & 0xff, crc16 >> 8);
                } else {
                    done = true;
                    currentPacket = [commandFirmwareTransfer, packetDone, seq & 0xff, seq >> 8];
                }
                break;
            }
            case packetDone: {
                console.log('Successfully uploaded firmware');
                return true;
            }
            case packetCRCError: {
                console.log('Upload failed due to CRC error');
                return false;
            }
        }
    }
}

async function getTime(transport) {
    const reply = await transport.sendAndReceive([0x40, 0x01, 0x01, 0x83, 0x01, 0x01]);
    if (!reply || reply.length < 16 || reply[0] != 0x40) return null;
    return `${reply[14]}:${reply[15]}`
}

function parseIntArgument(value, dummyPrevious) {
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      throw new commander.InvalidArgumentError('Not a number.');
    }
    return parsedValue;
}

program
    .name('zwave-pe653')
    .description('Firmware updater for the Intermatic PE653 / PE953 range of pool and spa controllers.')
    .version('0.1.0');

program.command('decrypt')
    .description('Decrypts a firmware archive and writes it to standard output')
    .argument('<file>', 'path to firmware archive (*.iboot)')
    .action((file, options) => {
        createFirmwareStream(file).pipe(process.stdout);
    });

program.command('describe')
    .description('Describes the contents of a firmware archive')
    .argument('<file>', 'path to firmware archive (*.iboot)')
    .option('--write-ihex', 'writes the blobs in ihex format next to the original file')
    .option('--write-bin', 'writes the blobs in binary format next to the original file')
    .action(async (file, options) => {
        const baseName = file.replace(/.iboot$/, '');
        const archive = await readFirmwareArchive(file,
            options.writeIhex ? function(name) {
                const output = baseName.concat('-', name, '.ihex');
                console.log(`Creating ${output}`);
                return fs.createWriteStream(output);
            } : null,
            options.writeBin ? function(name) {
                const output = baseName.concat('-', name, '.bin');
                console.log(`Creating ${output}`);
                return fs.createWriteStream(output);
            } : null);

        console.log('Firmware images:');
        console.dir(archive);
    });

program.command('fake-upload')
    .description('Pretends to upload firmware to a device')
    .argument('<file>', 'path to firmware archive (*.iboot)')
    .option('-d', 'debug output')
    .action(async (file, options) => {
        const archive = await readFirmwareArchive(file);
        if (options.d) {
            console.log('Firmware images:');
            console.dir(archive);
        }

        let transport = new FakeTransport(options.d);
        if (options.d) transport = new LogTransport(transport);

        const result = await uploadFirmware(archive.products['PE0653'].blob, transport);
        if (!result) process.exit(1);
    });

program.command('upload')
    .description('Uploads firmware to a device')
    .argument('<file>', 'path to firmware archive (*.iboot)')
    .argument('<nodeId>', 'Zwave node id to update', parseIntArgument)
    .argument('<mqtt>', 'zwavejs2mqtt server\'s MQTT broker URL, e.g. mqtt://user:password@host/')
    .argument('<api>', 'zwavejs2mqtt server\'s API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api')
    .option('-d', 'debug output')
    .action(async (file, nodeId, mqtt, api, options) => {
        const archive = await readFirmwareArchive(file);
        if (options.d) {
            console.log('Firmware images:');
            console.dir(archive);
        }

        let server = new ZwaveJS2MqttServer(mqtt, api, options.d);
        await server.connect();

        const nodeInfo = await server.getNodeInfo(nodeId);
        if (nodeInfo === null) {
            console.error(`Could not get information about node ${nodeId}`);
            process.exit(1);
        }
        if (options.d) {
            console.log('Node information:');
            console.dir(nodeInfo);
        }

        console.log('');
        console.log(`Node to upgrade:`);
        console.log(`- nodeId: ${nodeInfo.nodeId}`);
        console.log(`- name: ${nodeInfo.name}`);
        console.log(`- location: ${nodeInfo.location}`);
        console.log(`- current firmware version: ${nodeInfo.firmwareVersion}`);
        console.log('');

        const productId = getProductId(nodeInfo);
        if (productId === null) {
            console.error(`This program does not support upgrading the firmware of this node`);
            process.exit(1);
        }

        const product = archive.products[productId];
        if (product === undefined) {
            console.error(`The provided firmware archive does not contain a blob for product ${productId}`);
            process.exit(1);
        }

        console.log(`Upgrade to perform:`);
        console.log(`- new firmware version: ${product.version}`);
        console.log(`- new firmware hash: ${product.blobHash}`);
        console.log(`- product id: ${productId}`);
        console.log(`- product name: ${product.name}`);
        console.log(`- product notice: ${product.message}`);
        console.log('');

        const reader = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve, reject) => {
            reader.question('Proceed? [Enter "YES" to confirm] ', resolve);
        });
        reader.close();
        if (answer !== 'YES') {
            console.error('Upgrade declined by user');
            process.exit(1);
        }

        let transport = new ZwaveJS2MqttTransport(server, nodeId);
        if (options.d) transport = new LogTransport(transport);
        const result = await uploadFirmware(product.blob, transport);
        if (!result) process.exit(1);

        await server.disconnect();
    });

program.command('get-time')
    .description('Queries the current time from a PE653 as way to test communication with the node')
    .argument('<nodeId>', 'Zwave node id to update', parseIntArgument)
    .argument('<mqtt>', 'zwavejs2mqtt server\'s MQTT broker URL, e.g. mqtt://user:password@host/')
    .argument('<api>', 'zwavejs2mqtt server\'s API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api')
    .option('-d', 'debug output')
    .action(async (nodeId, mqtt, api, options) => {
        let server = new ZwaveJS2MqttServer(mqtt, api, options.d);
        await server.connect();

        const nodeInfo = await server.getNodeInfo(nodeId);
        if (nodeInfo === null) {
            console.error(`Could not get information about node ${nodeId}`);
            process.exit(1);
        }
        if (options.d) {
            console.log('Node information:');
            console.dir(nodeInfo);
        }

        const productId = getProductId(nodeInfo);
        if (productId !== "PE0653") {
            console.error(`This node is not a PE653`);
            process.exit(1);
        }

        let transport = new ZwaveJS2MqttTransport(server, nodeId);
        if (options.d) transport = new LogTransport(transport);

        const time = await getTime(transport);
        if (time) {
            console.log(`The current time according to the PE653 controller is: ${time}`);
        } else {
            console.error('Unable to communicate with the PE653 controller');
            process.exit(1);
        }

        await server.disconnect();
    });

program.parse();
