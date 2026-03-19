#include "managers/nfc_manager.h"

#include <cstring>
#include <SPI.h>
#include <MifareUltralight.h>
#include <NdefMessage.h>
#include <NdefRecord.h>
#include <NfcTag.h>

namespace {

constexpr uint8_t kType2PageSize = 4;
constexpr uint8_t kType2CcPage = 3;
constexpr uint8_t kType2DataStartPage = 4;
constexpr size_t kType2ReadBufferSize = 18;

bool isValidRc522Firmware(byte version) {
    return version == 0x91 || version == 0x92;
}

const char* uriPrefixForCode(uint8_t code) {
    switch (code) {
        case 0x00: return "";
        case 0x01: return "http://www.";
        case 0x02: return "https://www.";
        case 0x03: return "http://";
        case 0x04: return "https://";
        case 0x05: return "tel:";
        case 0x06: return "mailto:";
        case 0x07: return "ftp://anonymous:anonymous@";
        case 0x08: return "ftp://ftp.";
        case 0x09: return "ftps://";
        case 0x0A: return "sftp://";
        case 0x0B: return "smb://";
        case 0x0C: return "nfs://";
        case 0x0D: return "ftp://";
        case 0x0E: return "dav://";
        case 0x0F: return "news:";
        case 0x10: return "telnet://";
        case 0x11: return "imap:";
        case 0x12: return "rtsp://";
        case 0x13: return "urn:";
        case 0x14: return "pop:";
        case 0x15: return "sip:";
        case 0x16: return "sips:";
        case 0x17: return "tftp:";
        case 0x18: return "btspp://";
        case 0x19: return "btl2cap://";
        case 0x1A: return "btgoep://";
        case 0x1B: return "tcpobex://";
        case 0x1C: return "irdaobex://";
        case 0x1D: return "file://";
        case 0x1E: return "urn:epc:id:";
        case 0x1F: return "urn:epc:tag:";
        case 0x20: return "urn:epc:pat:";
        case 0x21: return "urn:epc:raw:";
        case 0x22: return "urn:epc:";
        case 0x23: return "urn:nfc:";
        default: return "";
    }
}

String statusCodeName(MFRC522::StatusCode status) {
    return String(MFRC522::GetStatusCodeName(status));
}

void setErrorMessage(String* error, const String& message) {
    if (error != nullptr) {
        *error = message;
    }
}

String bytesToHexString(const uint8_t* data, size_t length) {
    static const char kHex[] = "0123456789ABCDEF";
    String out;
    out.reserve(length * 2);

    for (size_t i = 0; i < length; ++i) {
        out += kHex[(data[i] >> 4) & 0x0F];
        out += kHex[data[i] & 0x0F];
    }

    return out;
}

String bytesToTypeString(const uint8_t* data, size_t length) {
    if (data == nullptr || length == 0) {
        return "";
    }

    String out;
    out.reserve(length);

    for (size_t i = 0; i < length; ++i) {
        if (data[i] >= 32 && data[i] <= 126) {
            out += static_cast<char>(data[i]);
        } else {
            out += '?';
        }
    }

    return out;
}

String decodeUriPayload(const uint8_t* payload, size_t length) {
    if (payload == nullptr || length == 0) {
        return "";
    }

    const uint8_t prefixCode = payload[0];
    String out = uriPrefixForCode(prefixCode);
    out.reserve(out.length() + length);

    for (size_t i = 1; i < length; ++i) {
        out += static_cast<char>(payload[i]);
    }

    return out;
}

bool isSupportedUrl(const String& url) {
    if (url.length() == 0 || url.length() > NDEF_URI_MAX_LENGTH) {
        return false;
    }

    return url.startsWith("http://") || url.startsWith("https://");
}

uint32_t estimateClassicCapacity(MFRC522::PICC_Type piccType) {
    if (piccType == MFRC522::PICC_TYPE_MIFARE_1K) {
        return 1024;
    }
    if (piccType == MFRC522::PICC_TYPE_MIFARE_4K) {
        return 4096;
    }
    if (piccType == MFRC522::PICC_TYPE_MIFARE_MINI) {
        return 320;
    }
    return 0;
}

uint8_t type2DynamicLockPage(uint32_t capacityBytes) {
    if (capacityBytes <= 144) {
        return 0x28;
    }
    if (capacityBytes <= 504) {
        return 0x82;
    }
    return 0xE2;
}

void describeType2ByCapacity(uint32_t capacityBytes, NfcCardInfo& card) {
    card.family = "Type 2 / NTAG";
    card.brand = "NXP / Ultralight";

    switch (capacityBytes) {
        case 48:
            card.family = "Type 2 / Ultralight";
            card.brand = "NXP / MIFARE Ultralight";
            break;
        case 144:
            card.family = "Type 2 / NTAG213";
            card.brand = "NXP / NTAG";
            break;
        case 504:
            card.family = "Type 2 / NTAG215";
            card.brand = "NXP / NTAG";
            break;
        case 888:
            card.family = "Type 2 / NTAG216";
            card.brand = "NXP / NTAG";
            break;
        default:
            break;
    }
}

} // namespace

NfcManager g_nfcManager;

bool NfcManager::begin() {
    Serial.println(F("[NFC] begin"));
    SPI.begin();

    g_mfrc522.PCD_Init();
    delay(NFC_INIT_DELAY_MS);
    g_mfrc522.PCD_SetAntennaGain(MFRC522::RxGain_max);
    g_nfc.begin(false);

    _firmwareVersion = g_mfrc522.PCD_ReadRegister(MFRC522::VersionReg);
    g_system.nfcFirmwareVersion = _firmwareVersion;

    _initialized = isValidRc522Firmware(_firmwareVersion);
    g_system.isNfcConnected = _initialized;

    if (!_initialized) {
        setLastError("nfc", "RC522_BAD_VERSION", String("Unexpected RC522 firmware value: 0x") + String(_firmwareVersion, HEX));
        Serial.print(F("[NFC] Invalid RC522 firmware=0x"));
        Serial.println(_firmwareVersion, HEX);
    } else {
        Serial.print(F("[NFC] RC522 firmware=0x"));
        Serial.println(_firmwareVersion, HEX);
    }

    return _initialized;
}

bool NfcManager::tagPresent() {
    if (!_initialized) {
        return false;
    }

    if (!nfcRequestLock()) {
        return false;
    }

    g_mfrc522.PCD_StopCrypto1();

    byte atqa[2] = {0};
    byte atqaSize = sizeof(atqa);
    const MFRC522::StatusCode status = g_mfrc522.PICC_RequestA(atqa, &atqaSize);

    nfcReleaseLock();

    if (status == MFRC522::STATUS_OK) {
        Serial.println(F("[NFC] PICC_RequestA OK"));
    }

    return status == MFRC522::STATUS_OK;
}

bool NfcManager::readTag(NfcCardInfo& card, String* error) {
    card.clear();
    setErrorMessage(error, "");

    if (!_initialized) {
        setErrorMessage(error, "RC522 not initialized");
        return false;
    }

    if (!_selectTag()) {
        setErrorMessage(error, "No supported NFC tag detected");
        Serial.println(F("[NFC] Read failed: no tag selected"));
        return false;
    }

    const bool success = _readSelectedTag(card, true);

    nfcReleaseLock();

    if (!success) {
        setErrorMessage(error, "Failed to read NFC tag");
        Serial.println(F("[NFC] Read failed after select"));
        return false;
    }

    Serial.print(F("[NFC] Read success uid="));
    Serial.print(card.uid);
    Serial.print(F(" family="));
    Serial.print(card.family);
    Serial.print(F(" ndef="));
    Serial.println(card.hasNdef ? F("1") : F("0"));

    return true;
}

bool NfcManager::writeTag(const String& url,
                          bool lockCard,
                          NfcCardInfo& card,
                          String* error) {
    card.clear();
    setErrorMessage(error, "");

    if (!_initialized) {
        setErrorMessage(error, "RC522 not initialized");
        return false;
    }

    if (!isSupportedUrl(url)) {
        setErrorMessage(error, "Only http/https URLs are accepted for NDEF URI write");
        return false;
    }

    if (!_selectTag()) {
        setErrorMessage(error, "No supported NFC tag detected");
        Serial.println(F("[NFC] Write failed: no tag selected"));
        return false;
    }

    _fillBaseCardInfo(card);
    card.lockRequested = lockCard;

    bool success = false;
    const MFRC522::PICC_Type piccType = g_mfrc522.PICC_GetType(g_mfrc522.uid.sak);

    if (piccType == MFRC522::PICC_TYPE_MIFARE_1K) {
        if (lockCard) {
            card.lockApplied = false;
            setErrorMessage(error, "Physical lock is not supported for MIFARE Classic cards");
            haltTag();
            nfcReleaseLock();
            return false;
        }
        success = _writeClassicTag(url, error);
    } else if (piccType == MFRC522::PICC_TYPE_MIFARE_UL) {
        success = _writeType2Tag(url, card, lockCard, error);
    } else {
        setErrorMessage(error, "Unsupported card type for NDEF writing");
    }
    haltTag();
    nfcReleaseLock();

    Serial.print(F("[NFC] Write result success="));
    Serial.print(success ? F("1") : F("0"));
    Serial.print(F(" uid="));
    Serial.println(card.uid);

    return success;
}

void NfcManager::haltTag() {
    g_nfc.haltTag();
    delay(NFC_TAG_DETECT_DELAY_MS);
}

bool NfcManager::_selectTag() {
    if (!nfcRequestLock()) {
        Serial.println(F("[NFC] Lock request failed"));
        return false;
    }

    if (!g_nfc.tagPresent()) {
        Serial.println(F("[NFC] g_nfc.tagPresent() == false"));
        nfcReleaseLock();
        return false;
    }

    Serial.println(F("[NFC] Tag selected"));

    return true;
}

void NfcManager::_fillBaseCardInfo(NfcCardInfo& card) {
    card.uid = bytesToHexString(g_mfrc522.uid.uidByte, g_mfrc522.uid.size);
    card.uidLength = g_mfrc522.uid.size;

    const MFRC522::PICC_Type piccType = g_mfrc522.PICC_GetType(g_mfrc522.uid.sak);
    card.piccTypeName = String(MFRC522::PICC_GetTypeName(piccType));

    switch (piccType) {
        case MFRC522::PICC_TYPE_MIFARE_MINI:
            card.family = "MIFARE Classic Mini";
            card.brand = "NXP / MIFARE";
            card.capacityBytes = estimateClassicCapacity(piccType);
            break;
        case MFRC522::PICC_TYPE_MIFARE_1K:
            card.family = "MIFARE Classic 1K";
            card.brand = "NXP / MIFARE";
            card.capacityBytes = estimateClassicCapacity(piccType);
            break;
        case MFRC522::PICC_TYPE_MIFARE_4K:
            card.family = "MIFARE Classic 4K";
            card.brand = "NXP / MIFARE";
            card.capacityBytes = estimateClassicCapacity(piccType);
            break;
        case MFRC522::PICC_TYPE_MIFARE_UL: {
            byte buffer[kType2ReadBufferSize] = {0};
            byte bufferSize = sizeof(buffer);
            if (g_mfrc522.MIFARE_Read(kType2CcPage, buffer, &bufferSize) == MFRC522::STATUS_OK && bufferSize >= 4) {
                card.capacityBytes = static_cast<uint32_t>(buffer[2]) * 8UL;
            }
            describeType2ByCapacity(card.capacityBytes, card);
            break;
        }
        default:
            card.family = "Unknown";
            card.brand = "Unknown";
            card.capacityBytes = estimateClassicCapacity(piccType);
            break;
    }
}

bool NfcManager::_readSelectedTag(NfcCardInfo& card, bool haltAfter) {
    if (!_initialized || !nfcHasLock()) {
        return false;
    }

    _fillBaseCardInfo(card);

    NfcTag tag = g_nfc.read();
    card.formatted = tag.isFormatted();
    card.hasNdef = false;
    card.ndefUrl = "";

    if (tag.hasNdefMessage()) {
        NdefMessage message = tag.getNdefMessage();
        const uint8_t recordCount = message.getRecordCount();

        if (recordCount > 0) {
            card.hasNdef = true;

            for (uint8_t index = 0; index < recordCount; ++index) {
                NdefRecord record = message.getRecord(index);
                const String type = bytesToTypeString(record.getType(), record.getTypeLength());
                if (record.getTnf() == NdefRecord::TNF_WELL_KNOWN && type == "U") {
                    card.ndefUrl = decodeUriPayload(record.getPayload(), record.getPayloadLength());
                    break;
                }
            }
        }
    }

    if (haltAfter) {
        haltTag();
    }

    return true;
}

bool NfcManager::_writeClassicTag(const String& url,
                                  String* error) {
    if (!g_nfc.format()) {
        setErrorMessage(error, "Failed to format MIFARE Classic tag for NDEF");
        return false;
    }

    NdefMessage message;
    message.addUriRecord(url.c_str());

    if (!g_nfc.write(message)) {
        setErrorMessage(error, "Failed to write NDEF URI to MIFARE Classic tag");
        return false;
    }

    return true;
}

bool NfcManager::_writeType2Tag(const String& url,
                                NfcCardInfo& card,
                                bool lockCard,
                                String* error) {
    byte ccReadBuffer[kType2ReadBufferSize] = {0};
    byte ccReadSize = sizeof(ccReadBuffer);
    const MFRC522::StatusCode ccStatus = g_mfrc522.MIFARE_Read(kType2CcPage, ccReadBuffer, &ccReadSize);

    if (ccStatus != MFRC522::STATUS_OK || ccReadSize < 4) {
        setErrorMessage(error, "Failed to read Type 2 capability container: " + statusCodeName(ccStatus));
        return false;
    }

    const uint8_t capacityField = ccReadBuffer[2];
    const uint16_t tagCapacity = static_cast<uint16_t>(capacityField) * 8U;
    const uint16_t messageLength = static_cast<uint16_t>(url.length()) + 5U;
    const uint16_t encodedLength = 2U + messageLength + 1U;

    if (capacityField == 0U || tagCapacity == 0U) {
        setErrorMessage(error, "Type 2 tag reports invalid NDEF capacity");
        return false;
    }

    if (encodedLength > tagCapacity) {
        setErrorMessage(error, "URL is larger than the available Type 2 tag capacity");
        return false;
    }

    byte ccPage[16] = {0};
    ccPage[0] = 0xE1;
    ccPage[1] = 0x10;
    ccPage[2] = capacityField;
    ccPage[3] = 0x00;

    if (ccReadBuffer[0] != ccPage[0] ||
        ccReadBuffer[1] != ccPage[1] ||
        ccReadBuffer[2] != ccPage[2] ||
        ccReadBuffer[3] != ccPage[3]) {
        const MFRC522::StatusCode writeCcStatus = g_mfrc522.MIFARE_Write(kType2CcPage, ccPage, 16);
        if (writeCcStatus != MFRC522::STATUS_OK) {
            setErrorMessage(error, "Failed to write Type 2 capability container: " + statusCodeName(writeCcStatus));
            return false;
        }
    }

    uint8_t encoded[2 + 5 + NDEF_URI_MAX_LENGTH + 1] = {0};
    size_t offset = 0;
    encoded[offset++] = 0x03;
    encoded[offset++] = static_cast<uint8_t>(messageLength);
    encoded[offset++] = 0xD1;
    encoded[offset++] = 0x01;
    encoded[offset++] = static_cast<uint8_t>(url.length() + 1U);
    encoded[offset++] = 0x55;
    encoded[offset++] = 0x00;

    for (size_t i = 0; i < static_cast<size_t>(url.length()); ++i) {
        encoded[offset++] = static_cast<uint8_t>(url.charAt(i));
    }

    encoded[offset++] = 0xFE;

    uint8_t pageBuffer[16] = {0};
    uint8_t page = kType2DataStartPage;
    size_t cursor = 0;

    while (cursor < offset) {
        memset(pageBuffer, 0, sizeof(pageBuffer));

        for (uint8_t i = 0; i < kType2PageSize && cursor < offset; ++i, ++cursor) {
            pageBuffer[i] = encoded[cursor];
        }

        const MFRC522::StatusCode writeStatus = g_mfrc522.MIFARE_Write(page, pageBuffer, 16);
        if (writeStatus != MFRC522::STATUS_OK) {
            setErrorMessage(error, "Failed to write Type 2 page " + String(page) + ": " + statusCodeName(writeStatus));
            return false;
        }

        ++page;
        yield();
    }

    if (lockCard) {
        byte lockPageBuffer[16] = {0};
        byte lockPageSize = sizeof(lockPageBuffer);
        const uint8_t dynamicLockPage = type2DynamicLockPage(tagCapacity);

        MFRC522::StatusCode lockStatus = g_mfrc522.MIFARE_Read(2, lockPageBuffer, &lockPageSize);
        if (lockStatus != MFRC522::STATUS_OK || lockPageSize < 4) {
            setErrorMessage(error, "Failed to read Type 2 lock bytes: " + statusCodeName(lockStatus));
            return false;
        }

        lockPageBuffer[2] = 0xFF;
        lockPageBuffer[3] = 0xFF;
        lockStatus = g_mfrc522.MIFARE_Write(2, lockPageBuffer, 16);
        if (lockStatus != MFRC522::STATUS_OK) {
            setErrorMessage(error, "Failed to write Type 2 static lock bytes: " + statusCodeName(lockStatus));
            return false;
        }

        memset(lockPageBuffer, 0, sizeof(lockPageBuffer));
        lockPageSize = sizeof(lockPageBuffer);
        lockStatus = g_mfrc522.MIFARE_Read(dynamicLockPage, lockPageBuffer, &lockPageSize);
        if (lockStatus != MFRC522::STATUS_OK || lockPageSize < 4) {
            setErrorMessage(error, "Failed to read Type 2 dynamic lock bytes: " + statusCodeName(lockStatus));
            return false;
        }

        lockPageBuffer[0] = 0xFF;
        lockPageBuffer[1] = 0xFF;
        lockPageBuffer[2] = 0xFF;
        lockStatus = g_mfrc522.MIFARE_Write(dynamicLockPage, lockPageBuffer, 16);
        if (lockStatus != MFRC522::STATUS_OK) {
            setErrorMessage(error, "Failed to write Type 2 dynamic lock bytes: " + statusCodeName(lockStatus));
            return false;
        }

        card.lockApplied = true;
    } else {
        card.lockApplied = false;
    }

    return true;
}
