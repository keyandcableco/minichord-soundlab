/* ============================================================================
 * minichordcontroller.js: Web MIDI transport to the minichord
 *
 * class MiniChordController: connects over Web MIDI (sysex), requests and
 * parses full settings dumps, sends single-parameter updates and bank
 * commands, and reports state through callbacks (onConnectionChange,
 * onDataReceived). Wire format: each value travels as two 7-bit bytes
 * (low % 128, high / 128); float parameters are scaled ×100 by the caller.
 * ========================================================================== */
class MiniChordController {
    constructor() {
      this.device = false;
      this.parameter_size = 256;
      this.color_hue_sysex_adress = 20;
      this.base_adress_rythm = 220;
      this.potentiometer_memory_adress = [4, 5, 6];
      this.modulation_adress = [14, 10, 12,16];
      this.volume_memory_adress = [2, 3];
      this.active_bank_number = -1;
      this.min_firmware_accepted = 0.02;
      this.firmware_adress = 7;
      this.float_multiplier = 100.0;
      this.MIDI_request_option = {
        sysex: true,
        software: false
      };
      this.onConnectionChange = null;
      this.onDataReceived = null;
      this.onNoteEvent = null;   // (role, type, note, velocity) for the live "Play" view
      this.json_reference="../json/minichord.json";
    }

    // Initialize MIDI connection
    async initialize() {
      try {
        console.log(">> Requesting MIDI access");
        const midiAccess = await navigator.requestMIDIAccess(this.MIDI_request_option);
        console.log(">> MIDI access granted");
        this.handleMIDIAccess(midiAccess);
        midiAccess.onstatechange = (event) => this.handleStateChange(event);
        return true;
      } catch (error) {
        console.log(">> ERROR: MIDI access failed");
        console.error(error);
        return false;
      }
    }

    // Handle MIDI access
    handleMIDIAccess(midiAccess) {
      console.log(">> Available outputs:");
      for (const entry of midiAccess.outputs) {
        const output = entry[1];
        if (output.name.includes("minichord") && output.name.includes("1") || output.name === "minichord") {
          console.log(
            `>>>> minichord sysex control port [type:'${output.type}'] id: '${output.id}' manufacturer: '${output.manufacturer}' name: '${output.name}' version: '${output.version}'`
          );
          this.device = output;
          const sysex_message = [0xF0, 0, 0, 0, 0, 0xF7];
          this.device.send(sysex_message);
        } else {
          console.log(
            `>>>> Other port [type:'${output.type}'] id: '${output.id}' manufacturer: '${output.manufacturer}' name: '${output.name}' version: '${output.version}'`
          );
        }
      }
      console.log(">> Available inputs:");
      for (const entry of midiAccess.inputs) {
        const input = entry[1];
        // Attach to every minichord input port. The device exposes two: the chord
        // port (Port 1, which also carries the SysEx parameter dump) and the harp
        // port (Port 2). We tag each by name so the "Play" view can tell chord
        // notes from harp notes; "single port mode" folds both onto Port 1.
        // (MINICHORD-REFERENCE.md §11.1)
        if (input.name.includes("minichord")) {
          const role = input.name.includes("2") ? "harp" : "chord";
          input.onmidimessage = (message) => this.routeMessage(role, message);
          console.log(
            `>>>> minichord input port [role:'${role}'] [type:'${input.type}'] id: '${input.id}' name: '${input.name}' version: '${input.version}'`
          );
        } else {
          console.log(
            `>>>> Other port [type:'${input.type}'] id: '${input.id}' manufacturer: '${input.manufacturer}' name: '${input.name}' version: '${input.version}'`
          );
        }
      }
      if (this.device === false) {
        console.log(">> ERROR: no minichord device found");
        if (this.onConnectionChange) {
          this.onConnectionChange(false, "Make sure the minichord is connected to the computer and turned on");
        }
      } else {
        console.log(">> minichord succesfully connected");
      }
    }

    // Handle MIDI state changes
    handleStateChange(event) {
      console.log(">> MIDI state change received");
      console.log(event);
      if (event.port.state === "disconnected" && this.device !== false && (event.port.name === "minichord Port 1" || event.port.name === "minichord")) {
        console.log(">> minichord was disconnected");
        this.device = false;
        if (this.onConnectionChange) {
          this.onConnectionChange(false, "> minichord disconnected, please reconnect");
        }
      }
      if (event.port.state === "connected" && this.device === false && (event.port.name === "minichord Port 1" || event.port.name === "minichord")) {
        console.log(">> a new device was connected");
        this.handleMIDIAccess(event.target);
      }
    }

    // Route an incoming MIDI message: a full SysEx dump goes to the parameter
    // handler (unchanged); short channel messages are decoded as note-on/off and
    // forwarded to onNoteEvent so the "Play" view can highlight buttons/strings.
    routeMessage(role, midiMessage) {
      const d = midiMessage.data;
      if (!d) return;
      if (d.length === this.parameter_size * 2 + 2) { this.processCurrentData(midiMessage); return; }
      if (d.length < 3) return;
      const status = d[0] & 0xF0;
      if (status !== 0x90 && status !== 0x80) return;   // note messages only
      const type = (status === 0x90 && d[2] > 0) ? "on" : "off";
      if (this.onNoteEvent) this.onNoteEvent(role, type, d[1], d[2]);
    }

    // Process incoming MIDI data
    processCurrentData(midiMessage) {
      const data = midiMessage.data.slice(1);
      if (data.length !== this.parameter_size * 2 + 1) {
        console.log(">> Non-sysex message received, ignoring");
      } else {
        const processedData = {
          parameters: [],
          rhythmData: [],
          bankNumber: data[2 * 1],
          firmwareVersion: 0
        };

        for (var i = 2; i < this.parameter_size; i++) {
          const sysex_value = data[2 * i] + 128 * data[2 * i + 1];
          if (i === this.firmware_adress) {
            processedData.firmwareVersion = sysex_value;
            if (processedData.firmwareVersion < this.min_firmware_accepted) {
              alert("Please update the minichord firmware");
            }
          } else if (i < this.base_adress_rythm + 16 && i > this.base_adress_rythm - 1) {
            const j = i - this.base_adress_rythm;
            const rhythmBits = [];
            for (var k = 0; k < 7; k++) {
              rhythmBits[k] = !!(sysex_value & (1 << k));
            }
            processedData.rhythmData[j] = rhythmBits;
            // also keep the raw step mask in parameters[] so the editor's grid + preset
            // matching see the live pattern (otherwise 220-235 are undefined → the grid
            // falls back to the default pattern and presets never match the dump)
            processedData.parameters[i] = sysex_value;
          } else {
            processedData.parameters[i] = sysex_value;
          }
        }

        this.active_bank_number = processedData.bankNumber;

        // Re-centre the pot pickup memory (addrs 4-6) and section volumes (2-3)
        // on every dump: a stale saved pot position would otherwise fight the
        // editor's values until the physical knob is moved. Mirrors the
        // behaviour of the official minicontrol app. (MINICHORD-REFERENCE.md §6.2)
        for (const i of this.potentiometer_memory_adress) {
          this.sendParameter(i, 512);
          processedData.parameters[i] = 512;
        }

        for (const i of this.volume_memory_adress) {
          this.sendParameter(i, 0.5 * 100);
          processedData.parameters[i] = 0.5 * 100;
        }

        if (this.onDataReceived) {
          this.onDataReceived(processedData);
        }
      }
    }

    // Send parameter to device
    sendParameter(address, value) {
      if (!this.device) return false;
      const first_byte = parseInt(value % 128);
      const second_byte = parseInt(value / 128);
      const first_byte_address = parseInt(address % 128);
      const second_byte_address = parseInt(address / 128);
      const sysex_message = [0xF0, first_byte_address, second_byte_address, first_byte, second_byte, 0xF7];
      this.device.send(sysex_message);
      return true;
    }

    // Ask the device to dump its full live parameter set back to us (firmware
    // control_command case 0 = "report all data"). Same message sent on connect.
    // Used to re-sync the UI/patch with the device's current state, e.g. after a
    // hardware-side preset change that the device does not auto-report.
    requestCurrentData() {
      if (!this.device) return false;
      this.device.send([0xF0, 0, 0, 0, 0, 0xF7]);
      return true;
    }

    // Reset memory
    resetMemory() {
      if (!this.device) return false;
      const sysex_message = [0xF0, 0, 0, 1, 0, 0xF7];
      this.device.send(sysex_message);
      return true;
    }

    // Save current settings
    saveCurrentSettings(bankNumber) {
      if (!this.device) return false;
      const sysex_message = [0xF0, 0, 0, 2, bankNumber, 0xF7];
      this.device.send(sysex_message);
      return true;
    }

    // Reset current bank
    resetCurrentBank() {
      if (!this.device || this.active_bank_number === -1) return false;
      const sysex_message = [0xF0, 0, 0, 3, this.active_bank_number, 0xF7];
      this.device.send(sysex_message);
      return true;
    }

    // Check if device is connected
    isConnected() {
      return this.device !== false;
    }

    // Get device info
    getDeviceInfo() {
      return {
        connected: this.isConnected(),
        activeBankNumber: this.active_bank_number,
        parameterSize: this.parameter_size,
        colorHueAddress: this.color_hue_sysex_adress,
        baseAddressRhythm: this.base_adress_rythm,
        floatMultiplier: this.float_multiplier
      };
    }

  }

// explicit global export: the class is consumed by soundlab.js
window.MiniChordController = MiniChordController;
