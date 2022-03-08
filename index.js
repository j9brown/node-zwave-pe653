const { program } = require('commander');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');
const mqtt = require('mqtt');

// The Intermatic manufacturer ID for ZWave products.
const manufacturerId = 0x0005;
const productType = 0x5045; // 'PE'

function getFirmwareLabel(nodeInfo) {
    if (nodeInfo.manufacturerId === manufacturerId &&
            nodeInfo.productType === productType) {
        if (nodeInfo.productId === 0x0653) return "PE0653";
        if (nodeInfo.productId === 0x0953) return "PE0953";
    }
    return null;
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

async function readFirmwareArchive(file) {
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
                    blob = blob.subarray(0, maxAddress);

                    if (archive.products[productId].blob !== undefined)
                        throw new Error('Encountered a second blob for the same product');
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

// XMODEM CRC16 algorithm
// Courtesy of: https://mdfs.net/Info/Comp/Comms/CRC16.htm
function updateCRC16(crc16, byte) {
    crc16 ^= byte << 8;
    for (let i = 0; i < 8; i++) {
        crc16 <<= 1;
        if (crc16 & 0x10000)
            crc16 = (crc16 ^ 0x1021) & 0xffff;
    }
    return crc16;
}

class LogTransport {
    constructor(inner) {
        this._inner = inner;
    }

    async send(packet) {
        console.log(`>> SEND ${packet}`);
        return await this._inner.send(packet);
    }

    async receive() {
        const packet = await this._inner.receive();
        console.log(`<< RECV ${packet}`);
        return packet;
    }
}

class FakeTransport {
    constructor(debug) {
        this._pendingReply = null;
        this._nextSeq = 0;
        this._state = 'wait';
        this._debug = debug;
    }

    async send(packet) {
        if (packet.length < 2 || packet[0] !== commandFirmwareTransfer) return;

        const type = packet[1];
        const seq = packet.length >= 4 ? packet[2] | (packet[3] << 8) : -1;
        switch (type) {
            case packetStart: {
                if (this._state !== 'wait') return;

                if (this._debug)
                    console.log('!! START');
                this._state = 'transfer';
                this._nextSeq = 0;
                break;
            }
            case packetData: {
                if (this._state !== 'transfer' || this._nextSeq !== seq || packet.length < 6) return;

                const data = packet.slice(4, packet.length - 2);
                const crc = packet[packet.length - 2] | (packet[packet.length - 1] << 8);
                let check = 0;
                for (let i = 0; i < packet.length - 2; i++)
                    check = updateCRC16(check, packet[i]);
                if (this._debug)
                    console.log(`!! DATA ${seq} ${data} ${crc} (${check})`);

                if (check !== crc) {
                    this._state = 'error';
                } else {
                    this._nextSeq++;
                }
                break;
            }
            case packetDone: {
                if (this._state !== 'transfer' || this._nextSeq !== seq || packet.length < 4) return;

                if (this._debug)
                    console.log(`!! DONE ${seq}`);
                this._state = 'done';
                break;
            }
        }
        switch (this._state) {
            case 'transfer':
                this._pendingReply = [commandFirmwareTransfer, packetDataRequest,
                        this._nextSeq & 255, this._nextSeq >> 8];
                break;
            case 'error':
                this._pendingReply = [commandFirmwareTransfer, packetCRCError,
                        this._nextSeq & 255, this._nextSeq >> 8];
                break;
            case 'done':
                this._pendingReply = [commandFirmwareTransfer, packetDone,
                        this._nextSeq & 255, this._nextSeq >> 8];
                break;
        }
    }

    receive() {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(this._pendingReply);
                this._pendingReply = null;
            }, 5);
        });
    }
}

class ZwaveJS2MqttTransport {
    constructor(url, api, debug) {
        this._url = url;
        this._callTopic = api + '/driverFunction/set';
        this._resultTopic = api + '/driverFunction';
        this._resolveResult = null;
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
            if (topic === this._resultTopic && this._resolveResult) {
                this._resolveResult(JSON.parse(message.toString()));
                this._resolveResult = null;
            }
        });

        await once(this._client, 'connect');

        await this._subscribe(this._resultTopic);
        console.log('Connected to Zwave2MQTT server via MQTT');
    }

    getNodeInfo(nodeId) {
        return this._driverFunction(`
            const nodeId = ${nodeId};
            const node = driver.controller.nodes.get(nodeId);
            if (node === undefined) return null;
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

    async send(packet) {
        // call driver.sendCommand?
    }

    async receive() {
        // call driver.waitForCommand?
        return null;
    }

    async _driverFunction(code) {
        const call = JSON.stringify({ args: [ code ]});
        await this._publish(this._callTopic, call);

        const response = await new Promise((resolve, reject) => {
            this._resolveResult = resolve;
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

async function uploadFirmware(blob, transport) {
    let currentSeq = -1;
    let currentPacket = [commandFirmwareTransfer, packetStart];
    let timeouts = 0;

    console.log('Starting firmware upload...');
    await transport.send(currentPacket);
    for (;;) {
        const reply = await transport.receive();
        if (reply === null) {
            timeouts++;
            if (timeouts < maxTimeouts) {
                console.log(`Timeout occurred, resending last packet (${timeouts}/${maxTimeouts})`);
                transport.send(currentPacket);
                continue;
            }
            console.log(`Upload failed due to timeout, giving up`);
            return false;
        }
        timeouts = 0;

        if (reply.length < 4) continue;
        if (reply[0] !== commandFirmwareTransfer) continue;
        const type = reply[1];
        const seq = reply[2] | (reply[3] << 8);
        switch (type) {
            case packetDataRequest:
                if (seq !== currentSeq + 1) continue;
                currentSeq = seq;
                const offset = seq * 32;
                if (offset % 1024 === 0)
                    console.log(`Sending data (${offset}/${blob.length})`);
                if (offset < blob.length) {
                    const data = blob.slice(offset, Math.min(offset + 32, blob.length));
                    currentPacket = [commandFirmwareTransfer, packetData, seq & 0xff, seq >> 8].concat(data);
                    let crc16 = 0;
                    currentPacket.forEach((byte) => { crc16 = updateCRC16(crc16, byte) });
                    currentPacket.push(crc16 & 0xff, crc16 >> 8);
                    await transport.send(currentPacket);
                } else {
                    currentPacket = [commandFirmwareTransfer, packetDone, seq & 0xff, seq >> 8];
                    await transport.send(currentPacket);
                }
                break;
            case packetDone:
                console.log('Successfully uploaded firmware');
                return true;
            case packetCRCError:
                console.log('Upload failed due to CRC error');
                return false;
        }
    }
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
    .action(async (file, options) => {
        const archive = await readFirmwareArchive(file);

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
    .argument('<nodeId>', 'Zwave node id to update')
    .argument('<mqtt>', 'ZwaveJS2MQTT server\'s MQTT broker URL, e.g. mqtt://user:password@host/')
    .argument('<api>', 'ZwaveJS2MQTT server\'s API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api')
    .option('-d', 'debug output')
    .action(async (file, nodeId, mqtt, api, options) => {
        const archive = await readFirmwareArchive(file);
        if (options.d) {
            console.log('Firmware images:');
            console.dir(archive);
        }

        let transport = new ZwaveJS2MqttTransport(mqtt, api, options.d);
        await transport.connect();

        const nodeInfo = await transport.getNodeInfo(nodeId);
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
        console.log(`- nodeId: ${nodeInfo.id}`);
        console.log(`- name: ${nodeInfo.name}`);
        console.log(`- location: ${nodeInfo.location}`);
        console.log(`- current firmware version: ${nodeInfo.firmwareVersion}`);
        console.log('');

        const firmwareLabel = getFirmwareLabel(nodeInfo);
        if (firmwareLabel === null) {
            console.error(`This program does not support upgrading the firmware of this node`);
            process.exit(1);
        }

        const product = archive.products[firmwareLabel];
        if (product === undefined) {
            console.error(`The provided firmware archive does not contain a blob for product ${firmwareLabel}`);
            process.exit(1);
        }

        console.log(`Upgrade to perform:`);
        console.log(`- new firmware version: ${product.version}`);
        console.log(`- new firmware hash: ${product.blobHash})`);
        console.log(`- product id: ${firmwareLabel}`);
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

        if (options.d) transport = new LogTransport(transport);
        const result = await uploadFirmware(archive.products['PE0653'].blob, transport);
        if (!result) process.exit(1);
    });

program.parse();
