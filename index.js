const { program } = require('commander');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');

// The Intermatic manufacturer ID for ZWave products.
const manufacturerId = 0x0005;

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
        this.inner = inner;
    }

    async send(packet) {
        console.log(`>> SEND ${packet}`);
        return await this.inner.send(packet);
    }

    async receive() {
        const packet = await this.inner.receive();
        console.log(`<< RECV ${packet}`);
        return packet;
    }
}

class FakeTransport {
    constructor(debug) {
        this.pendingReply = null;
        this.nextSeq = 0;
        this.state = 'wait';
        this.debug = debug;
    }

    async send(packet) {
        if (packet.length < 2 || packet[0] !== commandFirmwareTransfer) return;

        const type = packet[1];
        const seq = packet.length >= 4 ? packet[2] | (packet[3] << 8) : -1;
        switch (type) {
            case packetStart: {
                if (this.state !== 'wait') return;

                if (this.debug)
                    console.log('!! START');
                this.state = 'transfer';
                this.nextSeq = 0;
                break;
            }
            case packetData: {
                if (this.state !== 'transfer' || this.nextSeq !== seq || packet.length < 6) return;

                const data = packet.slice(4, packet.length - 2);
                const crc = packet[packet.length - 2] | (packet[packet.length - 1] << 8);
                let check = 0;
                for (let i = 0; i < packet.length - 2; i++)
                    check = updateCRC16(check, packet[i]);
                if (this.debug)
                    console.log(`!! DATA ${seq} ${data} ${crc} (${check})`);

                if (check !== crc) {
                    this.state = 'error';
                } else {
                    this.nextSeq++;
                }
                break;
            }
            case packetDone: {
                if (this.state !== 'transfer' || this.nextSeq !== seq || packet.length < 4) return;

                if (this.debug)
                    console.log(`!! DONE ${seq}`);
                this.state = 'done';
                break;
            }
        }
        switch (this.state) {
            case 'transfer':
                this.pendingReply = [commandFirmwareTransfer, packetDataRequest,
                        this.nextSeq & 255, this.nextSeq >> 8];
                break;
            case 'error':
                this.pendingReply = [commandFirmwareTransfer, packetCRCError,
                        this.nextSeq & 255, this.nextSeq >> 8];
                break;
            case 'done':
                this.pendingReply = [commandFirmwareTransfer, packetDone,
                        this.nextSeq & 255, this.nextSeq >> 8];
                break;
        }
    }

    receive() {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(this.pendingReply);
                this.pendingReply = null;
            }, 5);
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
        console.dir(archive);
    });

program.command('fake-upload')
    .description('Pretends to upload a firmware archive')
    .argument('<file>', 'path to firmware archive (*.iboot)')
    .option('-d', 'debug output')
    .action(async (file, options) => {
        const archive = await readFirmwareArchive(file);
        console.dir(archive);
        let transport = new FakeTransport(options.d);
        if (options.d) transport = new LogTransport(transport);
        const result = await uploadFirmware(archive.products['PE0653'].blob, transport);
        if (!result) process.exit(1);
    });

program.parse();
