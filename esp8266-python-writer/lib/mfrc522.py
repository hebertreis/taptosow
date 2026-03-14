from machine import Pin
import time

class MFRC522:
    OK = 0
    NOTAGERR = 1
    ERR = 2
    REQIDL = 0x26

    def __init__(self, spi, gpioRst, gpioCs):
        self.spi = spi
        self.rst = Pin(gpioRst, Pin.OUT)
        self.cs = Pin(gpioCs, Pin.OUT)
        self.cs.value(1)
        self.rst.value(1)
        self.init()

    def _wreg(self, reg, val):
        self.cs.value(0)
        self.spi.write(bytearray([(reg << 1) & 0x7E, val]))
        self.cs.value(1)

    def _rreg(self, reg):
        self.cs.value(0)
        self.spi.write(bytearray([((reg << 1) & 0x7E) | 0x80]))
        val = self.spi.read(1)[0]
        self.cs.value(1)
        return val

    def _sbit(self, reg, mask):
        self._wreg(reg, self._rreg(reg) | mask)

    def _cbit(self, reg, mask):
        self._wreg(reg, self._rreg(reg) & (~mask))

    def init(self):
        self.rst.value(0)
        time.sleep_ms(5)
        self.rst.value(1)
        time.sleep_ms(5)
        self._wreg(0x01, 0x0F) # SoftReset
        time.sleep_ms(5)
        self._wreg(0x2A, 0x8D) # TMode
        self._wreg(0x2B, 0x3E) # TPrescaler
        self._wreg(0x2D, 30)   # TReloadL
        self._wreg(0x2C, 0)    # TReloadH
        self._wreg(0x15, 0x40) # TXASK
        self._wreg(0x11, 0x3D) # Mode
        self._wreg(0x26, 0x7F) # RFCfgReg: Max Gain (48dB) for stability
        self._sbit(0x14, 0x03) # Antenna On

    def request(self, mode):
        self._wreg(0x0D, 0x07) # BitFramingReg
        (stat, recv, bits) = self._tcom(0x0C, [mode])
        if (stat != self.OK) or (bits != 0x10): stat = self.ERR
        return stat, bits

    def anticoll(self):
        # Cascade Level 1
        self._wreg(0x0D, 0x00)
        (stat, recv, bits) = self._tcom(0x0C, [0x93, 0x20])
        if stat != self.OK or len(recv) != 5: return self.ERR, []
        
        # Check BCC for CL1
        if (recv[0] ^ recv[1] ^ recv[2] ^ recv[3]) != recv[4]: return self.ERR, []

        if recv[0] == 0x88:
            # Cascade Tag detected: This is a 7-byte UID tag (NTAG215)
            # We must select CL1 to proceed to CL2
            ct_uid = recv[0:4] # 0x88 + 3 bytes
            # Calculate CRC for Select CL1
            buf = [0x93, 0x70] + recv
            buf += self._calculate_crc(buf)
            (stat, sak, bits) = self._tcom(0x0C, buf)
            if stat != self.OK: return self.ERR, []
            
            # Cascade Level 2
            self._wreg(0x0D, 0x00)
            (stat, recv2, bits) = self._tcom(0x0C, [0x95, 0x20])
            if stat != self.OK or len(recv2) != 5: return self.ERR, []
            
            # Check BCC for CL2
            if (recv2[0] ^ recv2[1] ^ recv2[2] ^ recv2[3]) != recv2[4]: return self.ERR, []
            
            # Full UID: 3 bytes from CL1 (skipping 0x88) + 4 bytes from CL2
            full_uid = ct_uid[1:] + recv2[0:4]
            return self.OK, full_uid
        else:
            # Standard 4-byte UID
            return self.OK, recv[0:4]

    def _tcom(self, cmd, send):
        recv = []
        bits = 0
        wait_irq = 0x30 if cmd == 0x0C else 0x10
        self._wreg(0x02, 0x77 | 0x80)
        self._cbit(0x04, 0x80)
        self._sbit(0x0A, 0x80) # Flush
        self._wreg(0x01, 0x00) # Idle
        for val in send: self._wreg(0x09, val)
        self._wreg(0x01, cmd)
        if cmd == 0x0C: self._sbit(0x0D, 0x80) # Start
        
        # Timeout loop
        for _ in range(200): # ~200ms max
            n = self._rreg(0x04)
            if (n & 0x01) or (n & wait_irq): break
            time.sleep_ms(1)
            
        self._cbit(0x0D, 0x80)
        error_reg = self._rreg(0x06)
        if (error_reg & 0x1B) == 0x00:
            stat = self.OK
            n = self._rreg(0x0A)
            last_bits = self._rreg(0x12) & 0x07
            bits = (n - 1) * 8 + last_bits if last_bits else n * 8
            if n > 0:
                for _ in range(n): recv.append(self._rreg(0x09))
        else:
            stat = self.ERR

        # Diagnostic dump when there is no data back or on error
        if (len(recv) == 0) or (stat != self.OK and stat is not None):
            try:
                fifo = self._rreg(0x0A)
                commirq = self._rreg(0x04)
                lastb = self._rreg(0x12)
                print("[DRV] _tcom debug: cmd=0x{:02X} send={} stat={} error_reg=0x{:02X} fifo={} commirq=0x{:02X} lastb=0x{:02X} recv={}".format(cmd, send, stat, error_reg, fifo, commirq, lastb, recv))
            except Exception:
                print("[DRV] _tcom debug: unable to read regs")

        return stat, recv, bits

    def auth(self, mode, addr, key, uid):
        # mode: 0x60 (KeyA) or 0x61 (KeyB)
        return self._tcom(0x0E, [mode, addr] + key + uid[0:4])[0]

    def stop_crypto1(self):
        self._cbit(0x08, 0x08)

    def read(self, addr):
        stat, recv, bits = self._tcom(0x0C, [0x30, addr])
        return stat, recv

    def _calculate_crc(self, data):
        self._wreg(0x01, 0x00)
        self._wreg(0x0D, 0x00)
        self._wreg(0x04, 0x04)
        for b in data: self._wreg(0x09, b)
        self._wreg(0x01, 0x03)
        for _ in range(255):
            n = self._rreg(0x04)
            if n & 0x04: break
        return [self._rreg(0x22), self._rreg(0x21)]

    def select_tag(self, uid):
        # Required for NTAG215 to enter ACTIVE state
        # Handle 4-byte and 7-byte UIDs
        if len(uid) == 4:
            buf = [0x93, 0x70] + uid + [uid[0]^uid[1]^uid[2]^uid[3]]
            buf += self._calculate_crc(buf)
            (stat, recv, bits) = self._tcom(0x0C, buf)
            if stat != self.OK: return self.ERR
            
        elif len(uid) == 7:
            # Optimization: Try CL2 Select first (assuming anticoll left tag in READY2)
            # This prevents resetting the tag state if it was just detected
            buf = [0x95, 0x70] + uid[3:7] + [uid[3]^uid[4]^uid[5]^uid[6]]
            buf += self._calculate_crc(buf)
            (stat, recv, bits) = self._tcom(0x0C, buf)
            if stat == self.OK: return self.OK

            # If CL2 direct select failed, try full cascade (CL1 then CL2)
            # CL1 Select
            ct = [0x88] + uid[0:3]
            buf = [0x93, 0x70] + ct + [0x88^uid[0]^uid[1]^uid[2]]
            buf += self._calculate_crc(buf)
            (stat, recv, bits) = self._tcom(0x0C, buf)
            if stat != self.OK: return self.ERR
            
            # CL2 Select
            buf = [0x95, 0x70] + uid[3:7] + [uid[3]^uid[4]^uid[5]^uid[6]]
            buf += self._calculate_crc(buf)
            (stat, recv, bits) = self._tcom(0x0C, buf)
            if stat != self.OK: return self.ERR
            
        return self.OK

    def write(self, addr, data):
        # data: list of 16 bytes
        stat, recv, bits = self._tcom(0x0C, [0xA0, addr])
        if stat != self.OK or bits != 4 or (recv[0] & 0x0F) != 0x0A:
            return self.ERR
        stat, recv, bits = self._tcom(0x0C, data)
        if stat != self.OK or bits != 4 or (recv[0] & 0x0F) != 0x0A:
            return self.ERR
        return self.OK

    def write_page(self, addr, data):
        # Write 4 bytes to a page (Ultralight/NTAG) - single attempt only
        if len(data) != 4: 
            return self.ERR
        
        # Send WRITE command (0xA2) + page address + 4 bytes of data
        stat, recv, bits = self._tcom(0x0C, [0xA2, addr] + data)
        
        # Check for ACK (0x0A nibble in response)
        if stat != self.OK or bits != 4 or len(recv) == 0 or (recv[0] & 0x0F) != 0x0A:
            print("[WRITE_FAIL] Page {}: stat={} bits={} recv={}".format(addr, stat, bits, recv))
            return self.ERR
        
        print("[WRITE_OK] Page {}".format(addr))
        return self.OK
