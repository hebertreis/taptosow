/**
 * @file nfc_manager.cpp
 * @brief NFC/RFID manager implementation
 */

#include "managers/nfc_manager.h"
#include "core/system_state.h"

NfcManager g_nfcManager;

// ============================================================================
// NFC Manager Implementation
// ============================================================================

bool NfcManager::begin() {
    Serial.println(F("\n[NFC] Initializing RC522..."));
    
    // Initialize SPI
    SPI.begin();
    
    // Initialize RC522
    g_mfrc522.PCD_Init();
    delay(NFC_INIT_DELAY_MS);
    
    // Set maximum antenna gain
    g_mfrc522.PCD_SetAntennaGain(g_mfrc522.RxGain_max);
    
    // Check firmware version
    _firmwareVersion = g_mfrc522.PCD_ReadRegister(g_mfrc522.VersionReg);
    Serial.print(F("[NFC] RC522 Firmware Version: 0x"));
    Serial.println(_firmwareVersion, HEX);
    
    // Store in global state
    g_system.nfcFirmwareVersion = _firmwareVersion;
    
    if (_firmwareVersion == 0x00 || _firmwareVersion == 0xFF) {
        Serial.println(F("[NFC] WARNING: RC522 not found or not responding!"));
        Serial.println(F("[NFC] Check wiring: SS=D2, RST=D1"));
        _initialized = false;
        g_system.isNfcConnected = false;
        return false;
    }
    
    Serial.println(F("[NFC] RC522 initialized successfully"));
    _initialized = true;
    g_system.isNfcConnected = true;
    
    // Test tag detection
    Serial.println(F("[NFC] Testing tag detection..."));
    byte bufferATQA[2];
    byte bufferSize = sizeof(bufferATQA);
    MFRC522::StatusCode status = g_mfrc522.PICC_RequestA(bufferATQA, &bufferSize);
    
    if (status == MFRC522::STATUS_OK) {
        Serial.println(F("[NFC] Tag detected during test!"));
    } else {
        Serial.print(F("[NFC] No tag present (status: "));
        Serial.println(g_mfrc522.GetStatusCodeName(status));
        Serial.println(F(") - This is normal if no tag is near"));
    }
    
    return true;
}

bool NfcManager::poll() {
    if (!_initialized) return false;
    
    // Check if enough time passed since last poll
    if (millis() - g_system.lastNfcPoll < NFC_POLL_INTERVAL_MS) {
        return false;
    }
    
    // Request exclusive NFC lock (coordinates with LCD)
    if (!_acquireLock()) {
        return false;
    }
    
    g_system.lastNfcPoll = millis();
    
    // Request tag (REQA) - standard MIFARE detection
    byte bufferATQA[2];
    byte bufferSize = sizeof(bufferATQA);
    byte status = g_mfrc522.PICC_RequestA(bufferATQA, &bufferSize);
    
    bool tagDetected = (status == MFRC522::STATUS_OK);
    
    // Release lock after polling
    _releaseLock();
    
    return tagDetected;
}

bool NfcManager::readTag(NfcTagData& tagData) {
    if (!_initialized) return false;
    
    // Acquire lock
    if (!_acquireLock()) {
        return false;
    }
    
    Serial.println(F("[NFC] Reading tag..."));
    
    // Get UID
    MFRC522::Uid uid;
    if (!g_mfrc522.PICC_ReadCardSerial()) {
        Serial.println(F("[NFC] Failed to read card serial"));
        _releaseLock();
        return false;
    }
    
    // Build UID string
    tagData.uid = "";
    for (byte i = 0; i < uid.size; i++) {
        if (uid.uidByte[i] < 0x10) tagData.uid += "0";
        tagData.uid += String(uid.uidByte[i], HEX);
        if (i < uid.size - 1) tagData.uid += ":";
    }
    tagData.uid.toUpperCase();
    
    Serial.print(F("[NFC] Tag UID: "));
    Serial.println(tagData.uid);
    
    // Try to read NDEF message
    NfcTag nfcTag = g_nfc.read();
    if (nfcTag.hasNdefMessage()) {
        tagData.hasNdef = true;
        tagData.ndefUrl = _extractNdefUrl();
        Serial.print(F("[NFC] NDEF URL: "));
        Serial.println(tagData.ndefUrl);
    }
    
    // Read sector data
    tagData.rawSectorData = _readAllSectorData();
    
    tagData.detectedAt = millis();
    
    // Halt tag
    g_mfrc522.PICC_HaltA();
    
    // Release lock
    _releaseLock();
    
    return true;
}

bool NfcManager::writeTag(const String& url) {
    if (!_initialized) return false;
    
    // Acquire lock
    if (!_acquireLock()) {
        return false;
    }
    
    Serial.println(F("[NFC] Writing tag..."));
    Serial.print(F("[NFC] URL: "));
    Serial.println(url);
    
    // Wait for tag
    unsigned long timeout = millis() + NFC_WRITE_TIMEOUT_MS;
    while (!g_nfc.tagPresent() && millis() < timeout) {
        delay(10);
        yield();
    }
    
    if (!g_nfc.tagPresent()) {
        Serial.println(F("[NFC] No tag present for write"));
        _releaseLock();
        return false;
    }
    
    // Read tag
    NfcTag tag = g_nfc.read();
    
    // Create NDEF message
    NdefMessage message = NdefMessage();
    message.addUriRecord(url.c_str());  // Convert String to const char*
    
    // Write message using NfcAdapter
    bool success = g_nfc.write(message);
    
    if (success) {
        Serial.println(F("[NFC] Write successful!"));
    } else {
        Serial.println(F("[NFC] Write failed!"));
    }
    
    // Wait for tag removal
    _waitForTagRemoval();
    
    // Release lock
    _releaseLock();
    
    return success;
}

bool NfcManager::tagPresent() {
    if (!_initialized) return false;
    return g_nfc.tagPresent();
}

bool NfcManager::_acquireLock() {
    // Request exclusive NFC access
    if (!nfcRequestLock()) {
        // LCD is active, wait or skip
        return false;
    }
    
    // LCD is now paused, SPI is initialized
    return true;
}

void NfcManager::_releaseLock() {
    nfcReleaseLock();
    lcdResumeAfterNfc();
}

void NfcManager::_waitForTagRemoval() {
    Serial.println(F("[NFC] Waiting for tag removal..."));
    unsigned long waitStart = millis();
    while (g_nfc.tagPresent() && (millis() - waitStart < 10000)) {
        yield();
        delay(100);
    }
    Serial.println(F("[NFC] Tag removed"));
}

String NfcManager::_readAllSectorData() {
    String sectorData = "";
    
    // MIFARE Classic 1K has 16 sectors
    for (byte sector = 0; sector < SECTOR_COUNT; sector++) {
        byte sectorTrailer = (sector * 4) + 3;
        
        // Authentication
        MFRC522::MIFARE_Key key;
        for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;
        
        MFRC522::StatusCode status = g_mfrc522.PCD_Authenticate(
            MFRC522::PICC_CMD_MF_AUTH_KEY_A,
            sectorTrailer,
            &key,
            &(g_mfrc522.uid)
        );
        
        if (status != MFRC522::STATUS_OK) {
            continue; // Skip unreadable sectors
        }
        
        // Read 4 blocks per sector
        for (byte block = sector * 4; block < (sector * 4) + 3; block++) {
            byte bufferSize = 18;
            byte buffer[18];
            
            status = g_mfrc522.MIFARE_Read(block, buffer, &bufferSize);
            
            if (status == MFRC522::STATUS_OK) {
                // Convert to hex string
                for (byte i = 0; i < 16; i++) {
                    if (buffer[i] < 0x10) sectorData += "0";
                    sectorData += String(buffer[i], HEX);
                    sectorData += " ";
                }
                sectorData += "| ";
            }
        }
        sectorData += "\n";
        g_mfrc522.PICC_HaltA();
    }
    
    return sectorData;
}

String NfcManager::_extractNdefUrl() {
    NfcTag tag = g_nfc.read();
    
    if (!tag.hasNdefMessage()) {
        return "";
    }
    
    NdefMessage message = tag.getNdefMessage();
    
    for (int i = 0; i < message.getRecordCount(); i++) {
        NdefRecord record = message.getRecord(i);
        
        // Check if it's a URI record
        byte tnf = record.getTnf();
        byte typeLen = record.getTypeLength();
        
        if (tnf == 0x01 && typeLen == 1 && record.getType()[0] == 0x55) {
            // URI record
            uint16_t payloadLen = record.getPayloadLength();
            if (payloadLen > 1) {
                byte prefixCode = record.getPayload()[0];
                String prefix = "";
                
                // URI prefix codes
                const char* prefixes[] = {
                    "", "http://www.", "https://www.", "http://", "https://",
                    "tel:", "mailto:", "ftp://anonymous:anonymous@", "ftp://ftp.",
                    "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://",
                    "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:",
                    "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://",
                    "tcpobex://", "irdaobex://", "file://", "urn:epc:id:",
                    "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"
                };
                
                if (prefixCode < 36) {
                    prefix = prefixes[prefixCode];
                }
                
                String uri = prefix;
                for (uint16_t j = 1; j < payloadLen; j++) {
                    char c = record.getPayload()[j];
                    if (c >= 32 && c < 127) uri += c;
                }
                
                return uri;
            }
        }
    }
    
    return "";
}
