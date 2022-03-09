function reverseBits8(x) {
    x = ((x << 4) & 0xf0) | ((x >>> 4) & 0x0f);
    x = ((x << 2) & 0xcc) | ((x >>> 2) & 0x33);
    x = ((x << 1) & 0xaa) | ((x >>> 1) & 0x55);
    return x;
}

function reverseBits32(x) {
    x = ((x << 16) & 0xffff0000) | ((x >>> 16) & 0x0000ffff);
    x = ((x << 8) & 0xff00ff00) | ((x >>> 8) & 0x00ff00ff);
    x = ((x << 4) & 0xf0f0f0f0) | ((x >>> 4) & 0x0f0f0f0f);
    x = ((x << 2) & 0xcccccccc) | ((x >>> 2) & 0x33333333);
    x = ((x << 1) & 0xaaaaaaaa) | ((x >>> 1) & 0x55555555);
    return x >>> 0;
}

function crc32brTableGen() {
    const polynomial = 0xedb88320;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i;
        for (let j = 0; j < 8; j++) {
            if (r & 1) {
                r = (r >>> 1) ^ polynomial;
            } else {
                r >>>= 1;
            }
        }
        table[reverseBits8(i)] = reverseBits32(r);
    }
    return table;
}
const crc32brTable = crc32brTableGen();

// CRC32 implementation that processes each byte in the buffer in a bit reversed
// order to mimic the behavior of the hardware CRC implementation in the
// Zwave microcontroller.
//
// This function is equivalent to: reverseBits32(~crc32(buf.map(reverseBits8)))
//
// Spec: https://www.silabs.com/documents/public/user-guides/INS11681-Instruction-500-Series-Z-Wave-Chip-Programming-Mode.pdf
// Courtesy of: https://stackoverflow.com/questions/51855906/fast-crc32-algorithm-for-reversed-bit-order
exports.crc32firmware = function(buf) {
    let crc32 = 0xffffffff;
    for (let x of buf) {
        crc32 = crc32brTable[x ^ (crc32 >>> 24)] ^ ((crc32 << 8) & 0xffffffff);
    }
    return crc32;
}

// XMODEM CRC16 algorithm used to check data blocks during the firmware upload.
//
// Courtesy of: https://mdfs.net/Info/Comp/Comms/CRC16.htm
exports.crc16update = function(crc16, byte) {
    crc16 ^= byte << 8;
    for (let i = 0; i < 8; i++) {
        crc16 <<= 1;
        if (crc16 & 0x10000)
            crc16 = (crc16 ^ 0x1021) & 0xffff;
    }
    return crc16;
}
