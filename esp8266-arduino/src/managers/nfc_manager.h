/**
 * @file nfc_manager.h
 * @brief NFC/RFID manager for OneTapGo
 */

#ifndef NFC_MANAGER_H
#define NFC_MANAGER_H

#include <ESP8266WiFi.h>
#include <MFRC522.h>
#include <NfcAdapter.h>
#include "core/system_state.h"

class NfcManager {
public:
    bool begin();
    bool tagPresent();
    bool selectTag();
    bool readTag(NfcCardInfo& card, String* error = nullptr);
    bool writeTag(const String& url,
                  bool lockCard,
                  NfcCardInfo& card,
                  String* error = nullptr);
    void haltTag();

    byte getFirmwareVersion() const { return _firmwareVersion; }
    bool isConnected() const { return _initialized; }
    String getLastUid() const;

private:
    bool _initialized = false;
    byte _firmwareVersion = 0x00;

    bool _selectTag();
    void _fillBaseCardInfo(NfcCardInfo& card);
    bool _readSelectedTag(NfcCardInfo& card, bool haltAfter = true);
    bool _writeClassicTag(const String& url,
                          String* error);
    bool _writeType2Tag(const String& url,
                        NfcCardInfo& card,
                        bool lockCard,
                        String* error);
};

extern NfcManager g_nfcManager;

#endif // NFC_MANAGER_H
