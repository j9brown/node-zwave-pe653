const { program } = require('commander');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');

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
    .argument('<file>', 'path to firmware acrive (*.iboot)')
    .action(async (file, options) => {
        let archive = await readFirmwareArchive(file);
        console.dir(archive);
    });

program.parse();

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
