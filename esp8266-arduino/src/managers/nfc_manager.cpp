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
constexpr uint8_t kType2WriteAttempts = 3;
constexpr uint8_t kType2WriteRetryDelayMs = 8;
constexpr uint8_t kTagSelectStabilizeDelayMs = 20;
constexpr uint8_t kClassicSectorCount1K = 16;
constexpr uint8_t kClassicFirstDataBlock = 4;
constexpr uint8_t kClassicBlocksPerSector = 4;

struct ClassicAuthCandidate {
    byte command;
    byte key[MFRC522::MF_KEY_SIZE];
    const char* label;
};

String bytesToHexString(const uint8_t* data, size_t length);

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

bool hasSelectedTag() {
    return g_mfrc522.uid.size > 0;
}

String formatAtqa(const byte* atqa, byte size) {
    if (atqa == nullptr || size == 0) {
        return "";
    }
    return bytesToHexString(atqa, size);
}

bool reselectCurrentTag(const char* phase) {
    g_mfrc522.PICC_HaltA();
    g_mfrc522.PCD_StopCrypto1();
    delay(kTagSelectStabilizeDelayMs);

    byte atqa[2] = {0};
    byte atqaSize = sizeof(atqa);
    MFRC522::StatusCode status = g_mfrc522.PICC_WakeupA(atqa, &atqaSize);
    if (status != MFRC522::STATUS_OK && status != MFRC522::STATUS_COLLISION) {
        status = g_mfrc522.PICC_RequestA(atqa, &atqaSize);
    }
    if (status != MFRC522::STATUS_OK && status != MFRC522::STATUS_COLLISION) {
        Serial.print(F("[NFC] Reselect failed phase="));
        Serial.print(phase);
        Serial.print(F(" request="));
        Serial.println(statusCodeName(status));
        return false;
    }

    status = g_mfrc522.PICC_Select(&(g_mfrc522.uid));
    if (status != MFRC522::STATUS_OK) {
        Serial.print(F("[NFC] Reselect failed phase="));
        Serial.print(phase);
        Serial.print(F(" select="));
        Serial.println(statusCodeName(status));
        return false;
    }

    delay(kTagSelectStabilizeDelayMs);
    return true;
}

void setErrorMessage(String* error, const String& message) {
    if (error != nullptr) {
        *error = message;
    }
}

bool writeType2PageWithRetry(uint8_t page,
                             const uint8_t* data,
                             String* error,
                             const String& label) {
    MFRC522::StatusCode lastStatus = MFRC522::STATUS_ERROR;

    for (uint8_t attempt = 0; attempt < kType2WriteAttempts; ++attempt) {
        if (attempt > 0 && !reselectCurrentTag("type2_retry")) {
            lastStatus = MFRC522::STATUS_TIMEOUT;
            continue;
        }

        byte writeBuffer[kType2PageSize] = {0};
        memcpy(writeBuffer, data, kType2PageSize);
        byte compatBuffer[16] = {0};
        memcpy(compatBuffer, data, kType2PageSize);

        lastStatus = g_mfrc522.MIFARE_Ultralight_Write(page, writeBuffer, sizeof(writeBuffer));
        if (lastStatus != MFRC522::STATUS_OK) {
            lastStatus = g_mfrc522.MIFARE_Write(page, compatBuffer, sizeof(compatBuffer));
        }

        if (lastStatus == MFRC522::STATUS_OK) {
            byte verifyBuffer[kType2ReadBufferSize] = {0};
            byte verifySize = sizeof(verifyBuffer);
            lastStatus = g_mfrc522.MIFARE_Read(page, verifyBuffer, &verifySize);
            if (lastStatus == MFRC522::STATUS_OK &&
                verifySize >= kType2PageSize &&
                memcmp(verifyBuffer, writeBuffer, kType2PageSize) == 0) {
                return true;
            }
        }

        delay(kType2WriteRetryDelayMs);
        yield();
    }

    setErrorMessage(error, label + " " + String(page) + ": " + statusCodeName(lastStatus));
    return false;
}

const ClassicAuthCandidate* classicAuthCandidates(size_t& count) {
    static const ClassicAuthCandidate kCandidates[] = {
        {MFRC522::PICC_CMD_MF_AUTH_KEY_A, {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}, "default_a"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_B, {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}, "default_b"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_A, {0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7}, "ndef_a"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_B, {0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7}, "ndef_b"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_A, {0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5}, "mad_a"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_B, {0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5}, "mad_b"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_A, {0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, "zero_a"},
        {MFRC522::PICC_CMD_MF_AUTH_KEY_B, {0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, "zero_b"},
    };
    count = sizeof(kCandidates) / sizeof(kCandidates[0]);
    return kCandidates;
}

bool authenticateClassicBlock(byte blockAddr,
                              MFRC522::MIFARE_Key* matchedKey,
                              byte* matchedCommand,
                              String* trace) {
    size_t candidateCount = 0;
    const ClassicAuthCandidate* candidates = classicAuthCandidates(candidateCount);
    String attempts;

    for (size_t i = 0; i < candidateCount; ++i) {
        MFRC522::MIFARE_Key key;
        memcpy(key.keyByte, candidates[i].key, MFRC522::MF_KEY_SIZE);

        g_mfrc522.PCD_StopCrypto1();
        const MFRC522::StatusCode status = g_mfrc522.PCD_Authenticate(
            candidates[i].command,
            blockAddr,
            &key,
            &(g_mfrc522.uid)
        );

        if (status == MFRC522::STATUS_OK) {
            if (matchedKey != nullptr) {
                *matchedKey = key;
            }
            if (matchedCommand != nullptr) {
                *matchedCommand = candidates[i].command;
            }
            if (trace != nullptr) {
                *trace = String(candidates[i].label);
            }
            Serial.print(F("[NFC] Classic auth block="));
            Serial.print(blockAddr);
            Serial.print(F(" key="));
            Serial.println(candidates[i].label);
            return true;
        }

        if (attempts.length() > 0) {
            attempts += ",";
        }
        attempts += candidates[i].label;
        attempts += "=";
        attempts += statusCodeName(status);
    }

    if (trace != nullptr) {
        *trace = attempts;
    }
    return false;
}

bool writeClassicFormatLayout(String* error) {
    byte emptyNdefMesg[16] = {0x03, 0x03, 0xD0, 0x00, 0x00, 0xFE, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
    byte blockbuffer0[16] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
    byte blockbuffer1[16] = {0x14, 0x01, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1};
    byte blockbuffer2[16] = {0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1, 0x03, 0xE1};
    byte blockbuffer3[16] = {0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x78, 0x77, 0x88, 0xC1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    byte blockbuffer4[16] = {0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7, 0x7F, 0x07, 0x88, 0x40, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

    for (byte sector = 0; sector < kClassicSectorCount1K; ++sector) {
        const byte block = sector * kClassicBlocksPerSector;
        MFRC522::MIFARE_Key matchedKey;
        byte matchedCommand = MFRC522::PICC_CMD_MF_AUTH_KEY_A;
        String authTrace;
        if (!authenticateClassicBlock(block == 0 ? 1 : block, &matchedKey, &matchedCommand, &authTrace)) {
            setErrorMessage(error, "Classic format auth failed on sector " + String(sector) + ": " + authTrace);
            return false;
        }

        if (sector == 0) {
            if (g_mfrc522.MIFARE_Write(1, blockbuffer1, 16) != MFRC522::STATUS_OK ||
                g_mfrc522.MIFARE_Write(2, blockbuffer2, 16) != MFRC522::STATUS_OK ||
                g_mfrc522.MIFARE_Write(3, blockbuffer3, 16) != MFRC522::STATUS_OK) {
                setErrorMessage(error, "Classic format write failed on MAD sector");
                return false;
            }
            continue;
        }

        const byte trailerBlock = block + 3;
        byte* firstBlockData = (block == kClassicFirstDataBlock) ? emptyNdefMesg : blockbuffer0;
        if (g_mfrc522.MIFARE_Write(block, firstBlockData, 16) != MFRC522::STATUS_OK ||
            g_mfrc522.MIFARE_Write(block + 1, blockbuffer0, 16) != MFRC522::STATUS_OK ||
            g_mfrc522.MIFARE_Write(block + 2, blockbuffer0, 16) != MFRC522::STATUS_OK ||
            g_mfrc522.MIFARE_Write(trailerBlock, blockbuffer4, 16) != MFRC522::STATUS_OK) {
            setErrorMessage(error, "Classic format write failed on sector " + String(sector));
            return false;
        }
    }

    g_mfrc522.PCD_StopCrypto1();
    return true;
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

    g_mfrc522.PCD_WriteRegister(MFRC522::RFCfgReg, 0x08 | 0x07);
    g_mfrc522.PCD_WriteRegister(MFRC522::ModWidthReg, RC522_MOD_WIDTH);
    g_mfrc522.PCD_WriteRegister(MFRC522::DemodReg, 0x4D);
    g_mfrc522.PCD_WriteRegister(MFRC522::TxControlReg, 0x83);

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
        Serial.print(F("[NFC] RFCfgReg=0x"));
        Serial.println(g_mfrc522.PCD_ReadRegister(MFRC522::RFCfgReg), HEX);
        Serial.print(F("[NFC] ModWidthReg=0x"));
        Serial.println(g_mfrc522.PCD_ReadRegister(MFRC522::ModWidthReg), HEX);
    }

    return _initialized;
}

String NfcManager::getLastUid() const {
    if (g_mfrc522.uid.size == 0) {
        return "";
    }
    char hexBuffer[32];
    for (byte i = 0; i < g_mfrc522.uid.size; i++) {
        sprintf(hexBuffer + i * 2, "%02X", g_mfrc522.uid.uidByte[i]);
    }
    return String(hexBuffer);
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

bool NfcManager::selectTag() {
    if (!_initialized) {
        return false;
    }

    return _selectTag();
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
    g_mfrc522.uid.size = 0;
    delay(NFC_TAG_DETECT_DELAY_MS);
}

bool NfcManager::_selectTag() {
    const bool lockWasHeld = nfcHasLock();
    if (!lockWasHeld && !nfcRequestLock()) {
        Serial.println(F("[NFC] Lock request failed"));
        return false;
    }

    if (lockWasHeld && hasSelectedTag()) {
        return true;
    }

    g_mfrc522.PCD_StopCrypto1();
    byte atqa[2] = {0};
    byte atqaSize = sizeof(atqa);
    MFRC522::StatusCode requestStatus;

#if NFC_USE_WAKEUP_FIRST
    requestStatus = g_mfrc522.PICC_WakeupA(atqa, &atqaSize);
    if (requestStatus != MFRC522::STATUS_OK && requestStatus != MFRC522::STATUS_COLLISION) {
        atqaSize = sizeof(atqa);
        requestStatus = g_mfrc522.PICC_RequestA(atqa, &atqaSize);
    }
#else
    requestStatus = g_mfrc522.PICC_RequestA(atqa, &atqaSize);
    if (requestStatus != MFRC522::STATUS_OK && requestStatus != MFRC522::STATUS_COLLISION) {
        atqaSize = sizeof(atqa);
        requestStatus = g_mfrc522.PICC_WakeupA(atqa, &atqaSize);
    }
#endif

    if (requestStatus != MFRC522::STATUS_OK && requestStatus != MFRC522::STATUS_COLLISION) {
        static unsigned long lastDiagTime = 0;
        unsigned long now = millis();
        if (now - lastDiagTime > 5000) {
            lastDiagTime = now;
            byte txControl = g_mfrc522.PCD_ReadRegister(MFRC522::TxControlReg);
            byte status2 = g_mfrc522.PCD_ReadRegister(MFRC522::Status2Reg);
            byte commIrq = g_mfrc522.PCD_ReadRegister(MFRC522::ComIrqReg);
            byte divIrq = g_mfrc522.PCD_ReadRegister(MFRC522::DivIrqReg);
            byte rxGain = g_mfrc522.PCD_ReadRegister(MFRC522::RFCfgReg);
            Serial.print(F("[NFC] Diag - TX=0x"));
            Serial.print(txControl, HEX);
            Serial.print(F(" RxGain=0x"));
            Serial.print(rxGain, HEX);
            Serial.print(F(" Status2=0x"));
            Serial.print(status2, HEX);
            Serial.print(F(" Irq=0x"));
            Serial.print(commIrq, HEX);
            Serial.print(F("/0x"));
            Serial.println(divIrq, HEX);
            if (!(txControl & 0x03)) {
                Serial.println(F("[NFC] WARNING: Antenna might be OFF!"));
                g_mfrc522.PCD_WriteRegister(MFRC522::TxControlReg, 0x83);
            }
            Serial.println(F("[NFC] Tip: Try holding tag 1-2mm above antenna coil"));
        }
        Serial.print(F("[NFC] Select request failed status="));
        Serial.println(statusCodeName(requestStatus));
        nfcReleaseLock();
        g_mfrc522.uid.size = 0;
        return false;
    }

    const MFRC522::StatusCode selectStatus = g_mfrc522.PICC_Select(&(g_mfrc522.uid));
    if (selectStatus != MFRC522::STATUS_OK) {
        Serial.print(F("[NFC] PICC_Select failed status="));
        Serial.println(statusCodeName(selectStatus));
        nfcReleaseLock();
        g_mfrc522.uid.size = 0;
        return false;
    }

    delay(kTagSelectStabilizeDelayMs);
    Serial.println(F("[NFC] Tag selected"));
    Serial.print(F("[NFC] ATQA="));
    Serial.print(formatAtqa(atqa, atqaSize));
    Serial.print(F(" SAK=0x"));
    Serial.print(g_mfrc522.uid.sak, HEX);
    Serial.print(F(" type="));
    Serial.println(MFRC522::PICC_GetTypeName(g_mfrc522.PICC_GetType(g_mfrc522.uid.sak)));

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
    NdefMessage message;
    message.addUriRecord(url.c_str());

    // Already-formatted Classic tags use NFC Forum keys, so re-formatting every
    // time breaks rewrites on cards that were previously prepared as NDEF.
    if (g_nfc.write(message)) {
        return true;
    }

    Serial.println(F("[NFC] Classic direct write failed, attempting format"));
    reselectCurrentTag("classic_after_direct_write");

    if (!g_nfc.format()) {
        Serial.println(F("[NFC] Library format failed, attempting extended Classic format"));
        reselectCurrentTag("classic_before_extended_format");
        String customFormatError;
        if (!writeClassicFormatLayout(&customFormatError)) {
            setErrorMessage(error, "Failed to write NDEF URI to MIFARE Classic tag and failed to format card for NDEF: " + customFormatError);
            return false;
        }
    }

    reselectCurrentTag("classic_before_final_write");

    if (!g_nfc.write(message)) {
        setErrorMessage(error, "Failed to write NDEF URI to MIFARE Classic tag after formatting");
        return false;
    }

    return true;
}

bool NfcManager::_writeType2Tag(const String& url,
                                NfcCardInfo& card,
                                bool lockCard,
                                String* error) {
    g_mfrc522.PCD_StopCrypto1();

    byte ccReadBuffer[kType2ReadBufferSize] = {0};
    byte ccReadSize = sizeof(ccReadBuffer);
    const MFRC522::StatusCode ccStatus = g_mfrc522.MIFARE_Read(kType2CcPage, ccReadBuffer, &ccReadSize);

    if (ccStatus != MFRC522::STATUS_OK || ccReadSize < 4) {
        setErrorMessage(error, "Failed to read Type 2 capability container: " + statusCodeName(ccStatus));
        return false;
    }

    Serial.print(F("[NFC] Type2 CC="));
    Serial.print(bytesToHexString(ccReadBuffer, 4));
    Serial.print(F(" uid="));
    Serial.println(card.uid);

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

    byte ccPage[kType2PageSize] = {0};
    ccPage[0] = 0xE1;
    ccPage[1] = 0x10;
    ccPage[2] = capacityField;
    ccPage[3] = 0x00;

    if (ccReadBuffer[0] != ccPage[0] ||
        ccReadBuffer[1] != ccPage[1] ||
        ccReadBuffer[2] != ccPage[2] ||
        ccReadBuffer[3] != ccPage[3]) {
        if (!writeType2PageWithRetry(kType2CcPage, ccPage, error, "Failed to write Type 2 capability container page")) {
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

    uint8_t pageBuffer[kType2PageSize] = {0};
    uint8_t page = kType2DataStartPage;
    size_t cursor = 0;

    while (cursor < offset) {
        memset(pageBuffer, 0, sizeof(pageBuffer));

        for (uint8_t i = 0; i < kType2PageSize && cursor < offset; ++i, ++cursor) {
            pageBuffer[i] = encoded[cursor];
        }

        if (!writeType2PageWithRetry(page, pageBuffer, error, "Failed to write Type 2 page")) {
            return false;
        }

        ++page;
        delay(kType2WriteRetryDelayMs);
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
        if (!writeType2PageWithRetry(2, lockPageBuffer, error, "Failed to write Type 2 static lock page")) {
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
        if (!writeType2PageWithRetry(dynamicLockPage, lockPageBuffer, error, "Failed to write Type 2 dynamic lock page")) {
            return false;
        }

        card.lockApplied = true;
    } else {
        card.lockApplied = false;
    }

    return true;
}
