/**
 * @file nfc_manager.h
 * @brief NFC/RFID manager for OneTapGo
 * 
 * Handles RC522 NFC reader with SPI/I2C coordination.
 * Requests exclusive lock before NFC operations to avoid pin conflicts with LCD.
 */

#ifndef NFC_MANAGER_H
#define NFC_MANAGER_H

#include <ESP8266WiFi.h>
#include <MFRC522.h>
#include <NfcAdapter.h>
#include "core/system_state.h"

// ============================================================================
// NFC Tag Data Structure
// ============================================================================
struct NfcTagData {
    String uid = "";
    String ndefUrl = "";
    bool hasNdef = false;
    String rawSectorData = "";
    unsigned long detectedAt = 0;
};

// ============================================================================
// NFC Manager Class
// ============================================================================
class NfcManager {
public:
    /**
     * Initialize NFC reader
     * @return true if RC522 is detected
     */
    bool begin();
    
    /**
     * Poll for NFC tags (with coordination)
     * @return true if tag detected
     */
    bool poll();
    
    /**
     * Read tag data (UID + NDEF)
     * @param tagData Output structure
     * @return true if read successful
     */
    bool readTag(NfcTagData& tagData);
    
    /**
     * Write NDEF URL to tag
     * @param url URL to write
     * @return true if write successful
     */
    bool writeTag(const String& url);
    
    /**
     * Check if a tag is present
     * @return true if tag detected
     */
    bool tagPresent();
    
    /**
     * Get RC522 firmware version
     */
    byte getFirmwareVersion() { return _firmwareVersion; }
    
    /**
     * Check if NFC is connected/initialized
     */
    bool isConnected() { return _initialized; }
    
private:
    bool _initialized = false;
    byte _firmwareVersion = 0x00;
    
    /**
     * Acquire NFC lock (for SPI/I2C coordination)
     * @return true if lock acquired
     */
    bool _acquireLock();
    
    /**
     * Release NFC lock
     */
    void _releaseLock();
    
    /**
     * Wait for tag removal
     */
    void _waitForTagRemoval();
    
    /**
     * Read all sector data from tag
     * @return Sector data as hex string
     */
    String _readAllSectorData();
    
    /**
     * Extract NDEF URL from tag
     * @return URL string or empty if not found
     */
    String _extractNdefUrl();
};

// ============================================================================
// Global NFC Manager Instance
// ============================================================================
extern NfcManager g_nfcManager;

#endif // NFC_MANAGER_H
