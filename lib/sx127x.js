let util = require("util");
let events = require("events");

let onoff = require("onoff");
let spi = require("spi-device");

let SPI_OPTIONS = {
  mode: spi.MODE0,
  maxSpeedHz: 12e6,
};

// registers
let REG_FIFO = 0x00;
let REG_OP_MODE = 0x01;
let REG_FRF = 0x06;
let REG_PA_CONFIG = 0x09;
let REG_LNA = 0x0c;
let REG_FIFO_ADDR_PTR = 0x0d;
let REG_FIFO_TX_BASE_ADDR = 0x0e;
let REG_FIFO_RX_BASE_ADDR = 0x0f;
let REG_FIFO_RX_CURRENT_ADDR = 0x10;
let REG_IRQ_FLAGS = 0x12;
let REG_RX_NB_BYTES = 0x13;
let REG_PKT_RSSI_VALUE = 0x1a;
let REG_PKT_SNR_VALUE = 0x1b;
let REG_MODEM_CONFIG_1 = 0x1d;
let REG_MODEM_CONFIG_2 = 0x1e;
let REG_PREAMBLE = 0x20;
let REG_PAYLOAD_LENGTH = 0x22;
let REG_MODEM_CONFIG_3 = 0x26;
let REG_RSSI_WIDEBAND = 0x2c;
let REG_DETECTION_OPTIMIZE = 0x31;
let REG_INVERT_IQ = 0x33; // when inverted stops end devices communicating with each other directly
let REG_DETECTION_THRESHOLD = 0x37;
let REG_SYNC_WORD = 0x39;
let REG_IMAGE_CALIBRATION = 0x3b;
let REG_TEMPERATURE = 0x3c;
let REG_DIO_MAPPING_1 = 0x40;
let REG_VERSION = 0x42;

// modes
let MODE_LONG_RANGE_MODE = 0x80;
let MODE_SLEEP = 0x00;
let MODE_STDBY = 0x01; // rf and pll disabled
let MODE_FSTX = 0x02; // frequency synthesis tx
let MODE_TX = 0x03;
let MODE_FSRX = 0x04; // frequency synthesis rx
let MODE_RX_CONTINUOUS = 0x05;
let MODE_RX_SINGLE = 0x06;

// PA config
let PA_BOOST = 0x80;

// IRQ masks
let IRQ_PAYLOAD_CRC_ERROR_MASK = 0x20;
let IRQ_TX_DONE_MASK = 0x08;
let IRQ_RX_DONE_MASK = 0x40;

// Temperature monitor masks
let RF_IMAGECAL_TEMPMONITOR_OFF = 0x01;
let RF_IMAGECAL_TEMPMONITOR_ON = 0x00;
let RF_IMAGECAL_TEMPMONITOR_MASK = 0xfe;

function SX127x(options) {
  this._spiBus = options.spiBus || 0;
  this._spiDevice = options.spiDevice || 0;
  this._resetPin = options.hasOwnProperty("resetPin") ? options.resetPin : 24;
  this._dio0Pin = options.hasOwnProperty("dio0Pin") ? options.dio0Pin : 25;
  this._frequency = options.frequency || 915e6;
  this._spreadingFactor = options.spreadingFactor || 7;
  this._signalBandwidth = options.signalBandwidth || 125e3;
  this._codingRate = options.codingRate || 4 / 5;
  this._preambleLength = options.preambleLength || 8;
  this._syncWord = options.syncWord || 0x12;
  this._txPower = options.txPower || 17;
  this._crc = options.crc || false;
  this._implicitHeaderMode = false;
  this._debug = options.debug || false;
  this._packetIndex = 0;
  this._tempCompensationFactor = options.tempCompensationFactor || 0;
  this._invertIqReg = options._invertIqReg || false;
}

util.inherits(SX127x, events.EventEmitter);

async function sleep(m) {
  return new Promise((r) => setTimeout(r, m));
}

SX127x.prototype._openSpi = async function (spiBus, spiDevice, SPI_OPTIONS) {
  return new Promise((resolve, reject) => {
    let spiObj = spi.open(spiBus, spiDevice, SPI_OPTIONS, (err) => {
      if (err) {
        reject(err);
      }
      resolve(spiObj);
    });
  });
};

SX127x.prototype._trace = function (message) {
  if (this._debug == true) {
    console.log("\x1b[36m%s\x1b[0m", "Debug sx127x: " + message);
  }
};

SX127x.prototype.open = async function () {
  // should throw errors on its own
  this._dio0Gpio = new onoff.Gpio(this._dio0Pin, "in", "rising");
  this._resetGpio = new onoff.Gpio(this._resetPin, "out");

  this._spi = await this._openSpi(this._spiBus, this._spiDevice, SPI_OPTIONS);
  await this._reset();
  let version = await this.readVersion();

  if (version != 0x12) {
    throw new Error("Invalid version " + version + ", expected 0x12");
  } else {
    this._trace("Chip version matches 0x12");
  }

  await this.sleep();

  if (this._invertIqReg) {
    await this.invertIqReg();
  }

  await this.setFrequency(this._frequency);
  await this.setSpreadingFactor(this._spreadingFactor);
  await this.setSignalBandwidth(this._signalBandwidth);
  await this.setCodingRate(this._codingRate);
  await this.setPreambleLength(this._preambleLength);
  await this.setSyncWord(this._syncWord);
  await this.setCrc(this._crc);
  await this._writeRegister(REG_FIFO_TX_BASE_ADDR, 0);
  await this._writeRegister(REG_FIFO_RX_BASE_ADDR, 0);
  await this.setLnaBoost(true);
  // // auto ACG, LowDataRateOptimize???
  await this._writeRegister(REG_MODEM_CONFIG_3, 0x04);
  await this.setTxPower(this._txPower);
  await this.standBy();
  await this._writeRegister(REG_IRQ_FLAGS, 0x00);
};

SX127x.prototype.close = async function () {
  await new Promise((resolve, reject) => {
    this._spi.close((err) => {
      if (err) {
        reject(err);
      }
      resolve();
    });
  });

  this._spi = null;
  this._dio0Gpio.unexport();
  this._resetGpio.unexport();
};

SX127x.prototype.readVersion = async function () {
  let version = await this._readRegister(REG_VERSION);
  return version;
};

SX127x.prototype.setFrequency = async function (frequency, callback) {
  this._frequency = frequency;

  let frequencyBuffer = new Buffer(4);

  frequencyBuffer.writeInt32BE(Math.floor((frequency / 32000000) * 524288));

  frequencyBuffer = frequencyBuffer.slice(1);

  await this._writeRegister(REG_FRF, frequencyBuffer);
};

SX127x.prototype.invertIqReg = async function () {
  let regInvertIQ = await this._readRegister(REG_INVERT_IQ);
  regInvertIQ |= 0x40;

  await this._writeRegister(REG_INVERT_IQ, regInvertIQ);
};

SX127x.prototype.setLnaBoost = async function (boost) {
  let lna = await this._readRegister(REG_LNA);
  if (boost) {
    lna |= 0x03;
  } else {
    lna &= 0xfc;
  }

  await this._writeRegister(REG_LNA, lna);
};

SX127x.prototype.setTxPower = async function (level, callback) {
  if (level < 2) {
    level = 2;
  } else if (level > 17) {
    level = 17;
  }

  this._txPower = level;

  await this._writeRegister(REG_PA_CONFIG, PA_BOOST | (level - 2));
};

SX127x.prototype.setSpreadingFactor = async function (sf) {
  if (sf < 6) {
    sf = 6;
  } else if (sf > 12) {
    sf = 12;
  }

  this._spreadingFactor = sf;

  let detectionOptimize = sf === 6 ? 0xc5 : 0xc3;
  let detectionThreshold = sf === 6 ? 0x0c : 0x0a;

  await this._writeRegister(REG_DETECTION_OPTIMIZE, detectionOptimize);
  await this._writeRegister(REG_DETECTION_THRESHOLD, detectionThreshold);
  let regModemConfig2 = await this._readRegister(REG_MODEM_CONFIG_2);
  regModemConfig2 &= 0x0f;
  regModemConfig2 |= sf << 4;
  await this._writeRegister(REG_MODEM_CONFIG_2, regModemConfig2);
};

SX127x.prototype.setSignalBandwidth = async function (sbw) {
  let bw;

  if (sbw <= 7.8e3) {
    bw = 0;
  } else if (sbw <= 10.4e3) {
    bw = 1;
  } else if (sbw <= 15.6e3) {
    bw = 2;
  } else if (sbw <= 20.8e3) {
    bw = 3;
  } else if (sbw <= 31.25e3) {
    bw = 4;
  } else if (sbw <= 41.7e3) {
    bw = 5;
  } else if (sbw <= 62.5e3) {
    bw = 6;
  } else if (sbw <= 125e3) {
    bw = 7;
  } else if (sbw <= 250e3) {
    bw = 8;
  } /*if (sbw <= 250E3)*/ else {
    bw = 9;
  }

  this._signalBandwidth = sbw;

  let regModemConfig1 = await this._readRegister(REG_MODEM_CONFIG_1);
  regModemConfig1 &= 0x0f;
  regModemConfig1 |= bw << 4;

  await this._writeRegister(REG_MODEM_CONFIG_1, regModemConfig1);
};

SX127x.prototype.setCodingRate = async function (cr, callback) {
  let denominator;

  if (cr <= 4 / 8) {
    denominator = 8;
  } else if (cr <= 4 / 7) {
    denominator = 7;
  } else if (cr <= 4 / 6) {
    denominator = 6;
  } /*if (cr <= (4/5))*/ else {
    denominator = 5;
  }

  this._codingRate = 4 / denominator;

  cr = denominator - 4;

  let regModemConfig1 = await this._readRegister(REG_MODEM_CONFIG_1);
  regModemConfig1 &= 0xf1;
  regModemConfig1 |= cr << 1;

  await this._writeRegister(REG_MODEM_CONFIG_1, regModemConfig1, callback);
};

SX127x.prototype.setPreambleLength = async function (length) {
  let lengthBuffer = new Buffer(2);

  this._preambleLength = length;

  lengthBuffer.writeUInt16BE(length, 0);

  await this._writeRegister(REG_PREAMBLE, lengthBuffer);
};

SX127x.prototype.setSyncWord = async function (sw) {
  this._syncWord = sw;

  await this._writeRegister(REG_SYNC_WORD, sw);
};

SX127x.prototype.setCrc = async function (crc) {
  this._crc = crc;
  let regModemConfig2 = await this._readRegister(REG_MODEM_CONFIG_2);

  if (crc) {
    regModemConfig2 |= 0x04;
  } else {
    regModemConfig2 &= 0xfb;
  }

  await this._writeRegister(REG_MODEM_CONFIG_2, regModemConfig2);
};

SX127x.prototype.readRandom = async function () {
  await this._readRegister(REG_RSSI_WIDEBAND);
};

SX127x.prototype.sleep = async function () {
  await this._writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_SLEEP);
};

SX127x.prototype.standBy = async function () {
  await this._writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_STDBY);
};

SX127x.prototype.setContinuousReceiveMode = async function (length) {
  if (arguments.length === 0) {
    length = 0;
  }

  // watch interrupt pin
  this._dio0Gpio.watch(this._onDio0Rise.bind(this));

  // default mode is explicit header
  this._implicitHeaderMode = length ? true : false;

  let regModemConfig1 = await this._readRegister(REG_MODEM_CONFIG_1);
  if (this._implicitHeaderMode) {
    regModemConfig1 |= 0x01;
  } else {
    regModemConfig1 &= 0xfe;
  }

  await this._writeRegister(REG_MODEM_CONFIG_1, regModemConfig1);
  // value of 0 is not allowed
  if (this._implicitHeaderMode) {
    await this._writeRegister(REG_PAYLOAD_LENGTH, length);
  }
  await this._writeRegister(REG_DIO_MAPPING_1, 0x00);
  await this._writeRegister(
    REG_OP_MODE,
    MODE_LONG_RANGE_MODE | MODE_RX_CONTINUOUS
  );
};

SX127x.prototype.receiveSingle = async function (length) {
  if (arguments.length === 0) {
    length = 0;
  }

  // unwatch interrupt pin
  if (this._dio0Gpio) {
    this._dio0Gpio.unwatch();
  }

  // default mode is explicit header
  this._implicitHeaderMode = length ? true : false;

  if (this._implicitHeaderMode) {
    await this._writeRegister(REG_PAYLOAD_LENGTH, length);
  }

  let packetLength = 0;
  let irqFlags = await this._readRegister(REG_IRQ_FLAGS);

  // clear IRQ's
  await this._writeRegister(REG_IRQ_FLAGS, irqFlags);

  if (
    irqFlags & IRQ_RX_DONE_MASK &&
    (irqFlags & IRQ_PAYLOAD_CRC_ERROR_MASK) == 0
  ) {
    // received a packet
    this._packetIndex = 0;

    // read packet length
    if (this._implicitHeaderMode) {
      packetLength = await this._readRegister(REG_PAYLOAD_LENGTH);
    } else {
      packetLength = await this._readRegister(REG_RX_NB_BYTES);
    }

    // set FIFO address to current RX address
    await this._writeRegister(
      REG_FIFO_ADDR_PTR,
      await this._readRegister(REG_FIFO_RX_CURRENT_ADDR)
    );

    // put in standby mode
    await this.standBy();
  } else if (
    (await this._readRegister(REG_OP_MODE)) !=
    (MODE_LONG_RANGE_MODE | MODE_RX_SINGLE)
  ) {
    // not currently in RX mode

    // reset FIFO address
    await this._writeRegister(REG_FIFO_ADDR_PTR, 0);

    // put in single RX mode
    await this._writeRegister(
      REG_OP_MODE,
      MODE_LONG_RANGE_MODE | MODE_RX_SINGLE
    );

    // verify we are in rx single mode
    for (let i = 0; i < 10; i++) {
      // the change can take a while, check a few times
      // before throwing
      if (
        (await this._readRegister(REG_OP_MODE)) !=
        (MODE_LONG_RANGE_MODE | MODE_RX_SINGLE)
      ) {
        await sleep(25);
      }
    }
    if (
      (await this._readRegister(REG_OP_MODE)) !=
      (MODE_LONG_RANGE_MODE | MODE_RX_SINGLE)
    ) {
      throw new Error("Could not change modes");
    }
  }

  return packetLength;
};

// send data through REG_FIFO
SX127x.prototype.write = async function (data, implicitHeader, callback) {
  this._trace("Sending: " + data);

  // watch interrupt pin for purposes of callback
  if (this._dio0Gpio) {
    this._dio0Gpio.unwatch();
  }

  if (arguments.length === 2) {
    callback = implicitHeader;
    implicitHeader = false;
  }

  this._writeCallback = callback;

  let regModemConfig1 = await this._readRegister(REG_MODEM_CONFIG_1);
  if (implicitHeader) {
    regModemConfig1 |= 0x01;
  } else {
    regModemConfig1 &= 0xfe;
  }

  await this._writeRegister(REG_MODEM_CONFIG_1, regModemConfig1);
  await this.standBy();
  await this._writeRegister(REG_FIFO_ADDR_PTR, 0);
  await this._writeRegister(REG_PAYLOAD_LENGTH, data.length);
  await this._writeRegister(REG_FIFO, data);
  await this._writeRegister(REG_DIO_MAPPING_1, 0x40);
  await this._writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_TX);

  // synchronously wait for TX done
  let i = 0;
  while (((await this._readRegister(REG_IRQ_FLAGS)) & IRQ_TX_DONE_MASK) == 0) {
    await sleep(1);
    i = i + 1;
    if (i > 100) {
      throw new Error("Write timeout");
    }
  }
  // clear IRQ's
  await this._writeRegister(REG_IRQ_FLAGS, IRQ_TX_DONE_MASK);
};

// resets the chip
SX127x.prototype._reset = async function () {
  this._resetGpio.writeSync(0);
  await sleep(10);
  this._resetGpio.writeSync(1);
  await sleep(10);
};

SX127x.prototype._readRegister = async function (register) {
  let readMessage = {
    sendBuffer: new Buffer([register & 0x7f, 0x00]),
    receiveBuffer: new Buffer(2),
    byteLength: 2,
  };

  if (!this._spi) {
    throw new Error("Spi not defined");
  }

  return new Promise((resolve, reject) =>
    this._spi.transfer([readMessage], function (err, messages) {
      if (err) {
        reject(err);
      }

      resolve(messages[0].receiveBuffer.readUInt8(1));
    })
  );
};

SX127x.prototype._readRegisterBytes = async function (
  register,
  length,
  callback
) {
  let sendBuffer = Buffer.concat([
    new Buffer([register & 0x7f]),
    new Buffer(length),
  ]);

  let readMessage = {
    sendBuffer: sendBuffer,
    receiveBuffer: new Buffer(sendBuffer.length),
    byteLength: sendBuffer.length,
  };

  if (!this._spi) {
    throw new Error("Spi not defined");
  }

  return new Promise((resolve, reject) =>
    this._spi.transfer([readMessage], function (err, messages) {
      if (err) {
        reject(err);
      }

      resolve(messages[0].receiveBuffer.slice(1));
    })
  );
};

SX127x.prototype._writeRegister = async function (register, value) {
  let sendBuffer;

  if (Buffer.isBuffer(value)) {
    sendBuffer = Buffer.concat([new Buffer([register | 0x80]), value]);
  } else {
    sendBuffer = new Buffer([register | 0x80, value]);
  }

  let writeMessage = {
    sendBuffer: sendBuffer,
    byteLength: sendBuffer.length,
  };

  return new Promise((resolve, reject) =>
    this._spi.transfer([writeMessage], function (err, messages) {
      if (err) {
        reject(err);
      }

      resolve();
    })
  );
};

// checks if we have any bytes incoming available for read
SX127x.prototype.available = async function () {
  return (await this._readRegister(REG_RX_NB_BYTES)) - this._packetIndex;
};

// reads one char of available incoming buffer
SX127x.prototype.read = async function () {
  if (!(await this.available())) {
    return -1;
  }

  this._packetIndex++;

  return await this._readRegister(REG_FIFO);
};

// interrupt handler for receive
SX127x.prototype._onDio0Rise = async function (err, value) {
  this._trace("Dio0 interrupt triggered");

  if (err || value === 0) {
    return;
  }

  // if this is in response to a write operation, writeCallback will be set
  if (this._writeCallback) {
    let irqFlags = await this._readRegister(REG_IRQ_FLAGS);
    await this._writeRegister(REG_IRQ_FLAGS, irqFlags);
    this._writeCallback();
    this._writeCallback = null;
  } else {
    let event = {};

    let irqFlags = await this._readRegister(REG_IRQ_FLAGS);
    event.irqFlags = irqFlags;
    await this._writeRegister(REG_IRQ_FLAGS, irqFlags);
    let rxAddr = await this._readRegister(REG_FIFO_RX_CURRENT_ADDR);
    await this._writeRegister(REG_FIFO_ADDR_PTR, rxAddr);
    let nbBytes = await this._readRegister(
      this._implicitHeaderMode ? REG_PAYLOAD_LENGTH : REG_RX_NB_BYTES
    );
    let data = await this._readRegisterBytes(REG_FIFO, nbBytes);
    event.data = data;
    let rssi = await this._readRegister(REG_PKT_RSSI_VALUE);
    event.rssi = rssi - (this._frequency < 868e6 ? 164 : 157);
    let snr = await this._readRegister(REG_PKT_SNR_VALUE);
    event.snr = new Buffer([snr]).readInt8() * 0.25;
    await this._writeRegister(REG_FIFO_ADDR_PTR, 0x00);
    if ((event.irqFlags & 0x20) === 0) {
      this._trace("Message received: " + event.data.toString());

      this.emit("data", event.data, event.rssi, event.snr);
    }
  }
};

SX127x.prototype.readTemperature = async function (err, value) {
  // save previous OP mode
  let previousOpMode = await this._readRegister(REG_OP_MODE);

  // lora sleep mode
  await this._writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE);

  // Set the device to Standby (FSK SLEEP MODE) and wait for oscillator startup
  await this._writeRegister(REG_OP_MODE, MODE_SLEEP);

  // Set the device to FSRx mode
  await this._writeRegister(REG_OP_MODE, MODE_FSRX);

  // Set TempMonitorOff = 0 (enables the sensor). It is not required to wait for the PLL Lock indication
  await this._writeRegister(
    REG_IMAGE_CALIBRATION,
    ((await this._readRegister(REG_IMAGE_CALIBRATION)) &
      RF_IMAGECAL_TEMPMONITOR_MASK) |
      RF_IMAGECAL_TEMPMONITOR_ON
  );

  // Wait for 140 microseconds (in our case, we just use 1ms)
  await sleep(1);

  // Set TempMonitorOff = 1
  await this._writeRegister(
    REG_IMAGE_CALIBRATION,
    ((await this._readRegister(REG_IMAGE_CALIBRATION)) &
      RF_IMAGECAL_TEMPMONITOR_MASK) |
      RF_IMAGECAL_TEMPMONITOR_OFF
  );

  // Set device back to Sleep of Standby mode (FSK SLEEP MODE)
  await this._writeRegister(REG_OP_MODE, MODE_SLEEP);

  // Access temperature value in RegTemp
  let temperature = await this._readRegister(REG_TEMPERATURE);

  // see figure 41 in datasheet for more info
  if (temperature > 128) {
    temperature = 255 - temperature;
  } else {
    temperature = temperature * -1;
  }

  // account for compensation factor (calibration value)
  temperature = temperature + this._tempCompensationFactor;

  // restore previous op mode
  await this._writeRegister(REG_OP_MODE, previousOpMode);

  return temperature;
};

module.exports = SX127x;
