/**
 * @file coordinator.cpp
 * @brief System coordinator implementation
 */

#include "core/coordinator.h"

// ============================================================================
// Coordinator Implementation
// ============================================================================

void Coordinator::begin() {
    Serial.println(F("\n========================================"));
    Serial.println(F("   ONETAPGO NFC WRITER v" DEVICE_VERSION));
    Serial.println(F("        BY CRE8 TECNOLOGIA"));
    Serial.println(F("========================================"));
    Serial.print(F("[SYS] Free heap: "));
    Serial.println(ESP.getFreeHeap());
    
    // Initialize state
    stateInit();
    
    // Initialize LCD first (for visual feedback)
    Serial.println(F("[SYS] Initializing LCD..."));
    g_lcd.begin();
    
    // Initialize WiFi
    Serial.println(F("[SYS] Initializing WiFi..."));
    g_wifiManager.begin();
    
    // Initialize MQTT
    Serial.println(F("[SYS] Initializing MQTT..."));
    g_mqttManager.begin(g_system.deviceId, g_system.mqttTopicBase);
    
    // Initialize NFC
    Serial.println(F("[SYS] Initializing NFC..."));
    g_nfcManager.begin();
    
    // Initial display update
    g_lcd.forceUpdate();
    
    Serial.println(F("\n[SYS] Initialization complete"));
    Serial.print(F("[SYS] Free heap: "));
    Serial.println(ESP.getFreeHeap());
}

void Coordinator::loop() {
    // Process MQTT (handles reconnection internally)
    g_mqttManager.loop();

    // Check WiFi connection
    if (!g_wifiManager.isConnected()) {
        // WiFi disconnected - update display
        g_lcd.forceUpdate();
    }

    // Handle NFC operations (with LCD coordination)
    handleNfcOperations();
    
    // Check NFC timeout when waiting for tag
    checkNfcTimeout();

    // Update LCD (only if not paused for NFC)
    g_lcd.showState();

    // Watchdog feed
    yield();
}

void Coordinator::handleNfcOperations() {
    // Only poll NFC in IDLE, WAITING_TAG, or READ_MODE states
    if (g_system.state != STATE_IDLE &&
        g_system.state != STATE_WAITING_TAG &&
        g_system.state != STATE_READ_MODE) {
        return;
    }
    
    // Start timeout counter when entering WAITING_TAG state
    if (g_system.state == STATE_WAITING_TAG && g_system.nfcWaitStartTime == 0) {
        g_system.nfcWaitStartTime = millis();
        g_system.nfcTimeoutWarningSent = false;
        Serial.println(F("[COORD] NFC wait timeout started"));
    }
    
    // Reset timeout when not in waiting state
    if (g_system.state != STATE_WAITING_TAG) {
        g_system.nfcWaitStartTime = 0;
        g_system.nfcTimeoutWarningSent = false;
    }

    // Poll for tags (with coordination)
    if (g_nfcManager.poll()) {
        // Tag detected!
        processTag();
    }
}

void Coordinator::checkNfcTimeout() {
    // Only check timeout when waiting for tag
    if (g_system.state != STATE_WAITING_TAG) {
        return;
    }
    
    // Check if timeout is enabled (non-zero)
    if (NFC_WAIT_TIMEOUT_MS <= 0) {
        return;
    }
    
    unsigned long elapsed = millis() - g_system.nfcWaitStartTime;
    
    // Send warning before timeout (if not already sent)
    if (!g_system.nfcTimeoutWarningSent && 
        elapsed >= (NFC_WAIT_TIMEOUT_MS - NFC_WARNING_BEFORE_MS)) {
        Serial.println(F("[COORD] NFC timeout warning - 5 seconds remaining"));
        
        // Show warning on display
        g_lcd.showMessage("ATENCAO", "Aproxime o tag!", 1000);
        
        g_system.nfcTimeoutWarningSent = true;
    }
    
    // Check for timeout
    if (elapsed >= NFC_WAIT_TIMEOUT_MS) {
        Serial.println(F("[COORD] NFC wait timeout!"));
        Serial.print(F("[COORD] Elapsed: "));
        Serial.print(elapsed);
        Serial.println(F("ms"));
        
        // Publish timeout notification via MQTT
        g_mqttManager.publishNfcTimeout(NFC_WAIT_TIMEOUT_MS);
        
        // Show timeout on display
        g_lcd.showMessage("TIMEOUT", "Nenhum tag detectado", 2000);
        
        // Reset state to standby
        g_system.nfcWaitStartTime = 0;
        g_system.nfcTimeoutWarningSent = false;
        g_system.hasPendingWriteCommand = false;
        g_system.pendingTenantId = "";
        g_system.pendingSectorId = "";
        g_system.pendingUrl = "";
        
        // Return to read mode (standby)
        modeSet(MODE_STANDBY);
        
        Serial.println(F("[COORD] NFC returned to standby"));
    }
}

void Coordinator::processTag() {
    Serial.println(F("[COORD] Tag detected!"));
    
    // Reset timeout counter
    g_system.nfcWaitStartTime = 0;
    g_system.nfcTimeoutWarningSent = false;

    // Pause LCD during NFC operation
    lcdPauseForNfc();

    if (g_system.hasPendingWriteCommand && g_system.mode == MODE_WRITER) {
        // Write mode - program tag
        writeTag();
    } else if (g_system.readMode) {
        // Read mode - read and publish
        readTag();
    }

    // Resume LCD after NFC operation
    lcdResumeAfterNfc();
}

void Coordinator::writeTag() {
    Serial.println(F("[COORD] Writing tag..."));
    
    stateSet(STATE_WRITING);
    g_lcd.forceUpdate();
    
    // Write tag
    bool success = g_nfcManager.writeTag(g_system.pendingUrl);
    
    if (success) {
        stateSet(STATE_SUCCESS);
        Serial.println(F("[COORD] Write successful!"));
        
        // Publish result
        g_mqttManager.publishWriteResult(true, g_system.pendingUrl);
        
        // Show success
        g_lcd.showMessage("SUCCESS!", "Tag gravado com sucesso", 2000);
        
        // Clear pending command
        g_system.hasPendingWriteCommand = false;
        g_system.pendingTenantId = "";
        g_system.pendingSectorId = "";
        g_system.pendingUrl = "";
        
        // Return to read mode
        modeSet(MODE_READER);
    } else {
        stateSet(STATE_ERROR);
        Serial.println(F("[COORD] Write failed!"));
        
        // Publish error
        g_mqttManager.publishWriteResult(false, "Write failed");
        
        // Show error
        g_lcd.showMessage("ERROR", "Falha na gravacao", 2000);
        
        // Return to waiting state
        stateSet(STATE_WAITING_TAG);
    }
    
    g_lcd.forceUpdate();
}

void Coordinator::readTag() {
    Serial.println(F("[COORD] Reading tag..."));
    
    stateSet(STATE_TAG_DETECTED);
    
    // Read tag data
    NfcTagData tagData;
    if (g_nfcManager.readTag(tagData)) {
        Serial.print(F("[COORD] Tag UID: "));
        Serial.println(tagData.uid);
        
        // Publish tag data
        g_mqttManager.publishTagData(tagData.uid, tagData.ndefUrl, tagData.rawSectorData);
        
        // Show on display
        String msg = "UID: " + tagData.uid.substring(0, 8);
        if (tagData.ndefUrl.length() > 0) {
            msg += " [NDEF]";
        }
        g_lcd.showMessage("Tag Detectada", msg.c_str(), 1500);
    } else {
        Serial.println(F("[COORD] Read failed!"));
        g_lcd.showMessage("ERROR", "Leitura falhou", 1000);
    }
    
    // Return to idle/read mode
    stateSet(STATE_READ_MODE);
    g_lcd.forceUpdate();
}
