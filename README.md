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

`$ npm start -- upload PE953_RELEASE_34.iboot <node id> <mqtt> <api topic>`

- *node id*: The Zwave node id of the device to update
- *mqtt*: zwavejs2mqtt server's MQTT broker URL, e.g. mqtt://user:password@host/
- *api*: zwavejs2mqtt server's API topic, e.g. zwavejs/_CLIENTS/ZWAVE_GATEWAY-HomeAssistant/api

### Get more information and see additional functions

`$ npm start -- --help`
