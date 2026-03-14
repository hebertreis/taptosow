import struct

# Exceptions
class InvalidNdef(Exception): pass
class InvalidNdefMessage(InvalidNdef): pass
class InvalidNdefRecord(InvalidNdef): pass

# Constants
FLAGS_MB = 0x80
FLAGS_ME = 0x40
FLAGS_SHORT = 0x10
FLAGS_ID = 0x08
FLAGS_TNF_MASK = 0x07

TNF_WELL_KNOWN = 0x01
RTD_URI = b'U'
RTD_URI_ABBRIV_NUM = 35

SIZE2STRUCT = {
    8: '<B',
    16: '<H',
    32: '<L',
}

class BufferWriter(object):
    def __init__(self):
        self.buffer = b''
        for size_bit in SIZE2STRUCT:
            method_name = 'write_%d' % size_bit
            setattr(self, method_name, lambda data, s=size_bit: self._write(s, data))

    def _write(self, size, data):
        try:
            self.buffer += struct.pack(SIZE2STRUCT[size], data)
        except struct.error:
            raise InvalidNdef('bad number')

    def write_bytes(self, data):
        self.buffer += data

    def get(self):
        return self.buffer

class NdefRecordFlags(object):
    def __init__(self):
        self.message_begin = False
        self.message_end = False
        self.short = False
        self.id = False

class NdefRecord(object):
    def __init__(self):
        self.flags = NdefRecordFlags()
        self.tnf = 0
        self.type_len = 0
        self.type = None
        self.id_len = 0
        self.id = None
        self.payload_len = 0
        self.payload = None

    def set_type(self, new_type):
        self.type = new_type
        self.type_len = len(self.type)

    def set_id(self, new_id):
        self.id = new_id
        self.id_len = len(self.id)
        self.flags.id = self.id_len > 0

    def set_payload(self, new_payload):
        self.payload = new_payload
        self.payload_len = len(self.payload)
        self.flags.short = self.payload_len < 256

    def to_buffer(self):
        w = BufferWriter()
        w.write_8(self._raw_flags() | self.tnf)
        w.write_8(self.type_len)
        if self.flags.short:
            w.write_8(self.payload_len)
        else:
            w.write_32(self.payload_len)
        if self.flags.id:
            w.write_8(self.id_len)
        w.write_bytes(self.type)
        if self.flags.id:
            w.write_bytes(self.id)
        w.write_bytes(self.payload)
        return w.get()

    def _raw_flags(self):
        raw = 0
        if self.flags.id:
            raw |= FLAGS_ID
        if self.flags.message_begin:
            raw |= FLAGS_MB
        if self.flags.message_end:
            raw |= FLAGS_ME
        if self.flags.short:
            raw |= FLAGS_SHORT
        return raw

class NdefMessage(object):
    def __init__(self):
        self.records = []

    def to_buffer(self):
        return b''.join(r.to_buffer() for r in self.records)

def new_message(*record_defs):
    records = []
    for record_def in record_defs:
        record = NdefRecord()
        record.tnf = record_def[0]
        record.set_type(record_def[1])
        record.set_id(record_def[2])
        record.set_payload(record_def[3])
        records.append(record)

    if records:
        records[0].flags.message_begin = True
        records[-1].flags.message_end = True

    message = NdefMessage()
    message.records = records
    return message