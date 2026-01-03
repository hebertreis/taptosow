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
        self._sbit(0x14, 0x03) # Antenna On

    def request(self, mode):
        self._wreg(0x0D, 0x07) # BitFramingReg
        (stat, recv, bits) = self._tcom(0x0C, [mode])
        if (stat != self.OK) or (bits != 0x10): stat = self.ERR
        return stat, bits

    def anticoll(self):
        self._wreg(0x0D, 0x00)
        (stat, recv, bits) = self._tcom(0x0C, [0x93, 0x20])
        if stat == self.OK:
            if len(recv) == 5:
                res = 0
                for i in range(4): res ^= recv[i]
                if res != recv[4]: stat = self.ERR
            else: stat = self.ERR
        return stat, recv

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
        if (self._rreg(0x06) & 0x1B) == 0x00:
            stat = self.OK
            n = self._rreg(0x0A)
            last_bits = self._rreg(0x12) & 0x07
            bits = (n - 1) * 8 + last_bits if last_bits else n * 8
            if n > 0:
                for _ in range(n): recv.append(self._rreg(0x09))
        else: stat = self.ERR
        return stat, recv, bits

    def auth(self, mode, addr, key, uid):
        # mode: 0x60 (KeyA) or 0x61 (KeyB)
        return self._tcom(0x0E, [mode, addr] + key + uid[0:4])[0]

    def stop_crypto1(self):
        self._cbit(0x08, 0x08)

    def read(self, addr):
        stat, recv, bits = self._tcom(0x0C, [0x30, addr])
        return stat, recv

    def write(self, addr, data):
        # data: list of 16 bytes
        stat, recv, bits = self._tcom(0x0C, [0xA0, addr])
        if stat != self.OK or bits != 4 or (recv[0] & 0x0F) != 0x0A:
            return self.ERR
        stat, recv, bits = self._tcom(0x0C, data)
        if stat != self.OK or bits != 4 or (recv[0] & 0x0F) != 0x0A:
            return self.ERR
        return self.OK
