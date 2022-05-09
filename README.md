# node-zwave-pe653

Firmware updater for the Intermatic PE653 / PE953 range of pool and spa controllers.

This is quick and dirty program to work around the problem that the official
firmware updater only runs on Windows XP.

It currently assumes that you have an instance of [zwavejs2mqtt](https://github.com/zwave-js/zwavejs2mqtt) running somewhere
(which was convenient for me at the time).  With a little work, it should be
possible to modify this program to talk to a Zwave transceiver directly over USB
or by other means.

**Use at your own risk.  This program may brick your devices!  (Though hopefully not...)**

## Usage

### Setup

Download the code and install its dependencies.

`$ npm install`

### Download and extract the firmware

Look here: http://intermatic-downloads.com/Multiwave.html

### View the contents of a firmware archive

`$ npm start -- describe PE953_RELEASE_34.iboot`

### Extract the contents of a firmware archive to take a closer look

`$ npm start -- describe PE953_RELEASE_34.iboot --write-ihex --write-bin`

### Upload the firmware to your devices

The `upload` command will retrieve information about the node, confirm that it's compatible
with the firmware (to the extent possible), and prompt the user before proceeding
to upload and flash the new firmware.

The entire process will take several minutes to complete.

`$ npm start -- upload PE953_RELEASE_34.iboot <node id> <mqtt> <api topic>`

- *node id*: The Zwave node id of the device to update
- *mqtt*: zwavejs2mqtt server's MQTT broker URL, e.g. mqtt://user:password@host/
- *api*: zwavejs2mqtt server's API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api

### Verify communication with the PE653 controller

The `get-time` command is useful for testing that the program can send and receive manufacturer
proprietary commands to the device.  This command only works for the PE653 controller, not
for the PE953 remote control.

`$ npm start -- get-time <node id> <mqtt> <api topic>`

- *node id*: The Zwave node id of the device to update
- *mqtt*: zwavejs2mqtt server's MQTT broker URL, e.g. mqtt://user:password@host/
- *api*: zwavejs2mqtt server's API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api

### Get more information and see additional functions

`$ npm start -- --help`

## Technical Information

The PE653 and PE953 contain a STM32F101RC microcontroller with 256 KB of flash and
32 KB of RAM along with a ZW0301 Zwave transceiver.

The devices use a simple protocol to receive firmware updates over the air as a sequence
of 32 byte packets. The firmware is 116 KB so it takes 3712 packets to transmit the data
plus a few more to start and end the transfer. It may require several minutes to complete.

The firmware updater operates in two phases. First it verifies the checksum of each packet
as it is received and stores it into a reserved area of the flash memory. Once all of the
data has been received, it overwrites the original firmware with the new one and reboots.

This process should be somewhat resilient to incomplete transfers and certain forms of
data corruption. If the transfer fails partway, simply wait for the device to timeout and
reset itself then try again.

However, it's still possible to brick the devices. Fortunately they contain a programming
header that you can use to recover.

### Firmware Recovery

You'll need an ST-Link v2 interface (original or a clone) and the STM32CubeProgrammer
software (or compatible debugging tools for the STM32 microcontoller).

The programming header is an [ARM Standard JTAG](https://www.keil.com/support/man/docs/ulinkpro/ulinkpro_hw_if_jtag20.htm)
interface with 20 pins. We'll use 4 pins to access the microcontroller's Serial Wire Debug
(SWD) function.

Hook up these 4 pins up to your ST-Link interface as indicated:

  * Pin 7: SWDIO
  * Pin 9: SWCLK
  * Pin 15: RST
  * Pin 20: GND

(Do not hook up VCC as you may damage the device or your computer!)

Plug the ST-Link into your computer then power on the device and connect to it using the
STM32CubeProgrammer software. You may need to press a button on the handheld remote to wake
up the microcontroller.

First, make a backup of the existing firmware on the device!

  * Read the entire 256 KB of flash starting at address 0x08000000, size 0x40000.
  * Save it to a file somewhere safe.

Next, use the `describe` command to extract the firmware as a binary blob.

  * `$ npm start -- describe PE953_RELEASE_34.iboot --write-bin`

Finally, program the firmware into device.

  * Locate the correct firmware for the device.
    * Receiver: PE953_RELEASE_34-PE0653.bin
    * Handheld unit: PE953_RELEASE_34-PE0953.bin
  * Set the start address to 0x08002000.
    * WARNING: The firmware is not located at the start of flash memory. Don't accidentally
      overwrite the bootloader at 0x08000000! Double-check that the start address is set to
      0x08002000 before proceeding.
  * Flash the firmware.
  * Unplug the ST-Link interface from your computer and disconnect it from the device's
    programming header.

With luck, this worked and your device is running the new firmware. If not, you have a
backup of the flash so you can try again. Make sure you used the correct firmware binary
and start address.

### Flash Memory Map

Here's what I've been able to infer about the memory map of the device's flash memory:

  * 0x08000000 - 0x0803FFFF: Flash memory, size: 0x40000 (256 KB)
  * 0x08000000 - 0x08001FFF: Bootloader, size: 0x2000 (8 KB)
  * 0x08002000 - 0x0801EFFF: Firmware, size: 0x1D000 (116 KB)
  * 0x0801F000 - 0x0803BFFF: Uploaded temporary copy of firmware, size: 0x1D000 (116 KB)
  * 0x0803C000 - 0x0803FFFF: Non-volatile data?, size: 0x4000 (16 KB)
