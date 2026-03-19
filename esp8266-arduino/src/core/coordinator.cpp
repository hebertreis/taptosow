/**
 * @file coordinator.cpp
 * @brief System coordinator implementation
 */

#include "core/coordinator.h"

namespace {
String defaultErrorCodeFor(NfcCommandType command) {
    switch (command) {
        case NFC_CMD_WRITE:
            return "write_failed";
        case NFC_CMD_READ:
            return "read_failed";
        case NFC_CMD_NONE:
        default:
            return "nfc_error";
    }
}

String extractErrorCode(const String& rawError, NfcCommandType command) {
    if (rawError.length() == 0) {
        return defaultErrorCodeFor(command);
    }

    int pipeIndex = rawError.indexOf('|');
    if (pipeIndex > 0) {
        return rawError.substring(0, pipeIndex);
    }

    int colonIndex = rawError.indexOf(':');
    if (colonIndex > 0) {
        return rawError.substring(0, colonIndex);
    }

    return defaultErrorCodeFor(command);
}

String extractErrorMessage(const String& rawError, NfcCommandType command) {
    if (rawError.length() == 0) {
        return defaultErrorCodeFor(command);
    }

    const int length = rawError.length();
    int pipeIndex = rawError.indexOf('|');
    if (pipeIndex > 0 && pipeIndex < (length - 1)) {
        return rawError.substring(pipeIndex + 1);
    }

    int colonIndex = rawError.indexOf(':');
    if (colonIndex > 0 && colonIndex < (length - 1)) {
        return rawError.substring(colonIndex + 1);
    }

    return rawError;
}

void logStateSnapshot(const char* prefix) {
    Serial.print(prefix);
    Serial.print(F(" state="));
    Serial.print(deviceStateName((DeviceState)g_system.state));
    Serial.print(F(" wifi="));
    Serial.print(g_system.isWifiConnected ? F("1") : F("0"));
    Serial.print(F(" mqtt="));
    Serial.print(g_system.isMqttConnected ? F("1") : F("0"));
    Serial.print(F(" nfc="));
    Serial.print(g_system.isNfcConnected ? F("1") : F("0"));
    Serial.print(F(" job="));
    Serial.print(nfcJobActive() ? nfcCommandName(g_system.nfcJob.command) : F("none"));
    Serial.print(F(" heap="));
    Serial.println(ESP.getFreeHeap());
}
}

void Coordinator::begin() {
    Serial.println(F("\n========================================"));
    Serial.println(F("   ONETAPGO NFC WRITER v" DEVICE_VERSION));
    Serial.println(F("        BY CRE8 TECNOLOGIA"));
    Serial.println(F("========================================"));
    Serial.print(F("[SYS] Free heap: "));
    Serial.println(ESP.getFreeHeap());

    stateInit();

    Serial.println(F("[SYS] Preparing SPI bus..."));
    SPI.begin();

    if (LCD_ENABLED) {
        Serial.println(F("[SYS] Initializing LCD..."));
        g_lcd.begin();
    } else {
        Serial.println(F("[SYS] LCD disabled"));
    }

    Serial.println(F("[SYS] Initializing WiFi..."));
    g_wifiManager.begin();

    Serial.println(F("[SYS] Initializing MQTT..."));
    g_mqttManager.begin(g_system.deviceId, g_system.mqttTopicBase);

    Serial.println(F("[SYS] Initializing NFC..."));
    g_nfcManager.begin();

    // Update state after all hardware is initialized
    if (g_system.portalActive) {
        stateSet(STATE_WIFI_SETUP);
    } else if (!nfcJobActive() && g_system.state == STATE_BOOT) {
        stateSet(STATE_IDLE);
    }
    _observedJobStartedAt = 0;

    if (LCD_ENABLED) {
        g_lcd.forceUpdate();
    }
    g_mqttManager.publishStatus(true);

    Serial.println(F("\n[SYS] Initialization complete"));
    Serial.print(F("[SYS] Free heap: "));
    Serial.println(ESP.getFreeHeap());
}

void Coordinator::loop() {
    static DeviceState lastLoggedState = STATE_BOOT;
    static bool lastJobActive = false;
    static unsigned long lastHeartbeatLog = 0;

    

    if (nfcJobActive()) {
        _handleNfcJob();
    } else {
        nfcReleaseLock();
        lcdResumeUpdates();
        if (g_system.legacyReadMode && g_system.isNfcConnected) {
            _handleLegacyReadMode();
        } else {
            _syncIdleState();
        }
    }

    g_lcd.showState();

    g_wifiManager.loop();
    g_mqttManager.loop();

    if (g_system.state != lastLoggedState) {
        Serial.print(F("[LOOP] State -> "));
        Serial.println(deviceStateName((DeviceState)g_system.state));
        lastLoggedState = (DeviceState)g_system.state;
    }

    if (nfcJobActive() != lastJobActive) {
        Serial.print(F("[LOOP] Job active -> "));
        Serial.println(nfcJobActive() ? F("YES") : F("NO"));
        lastJobActive = nfcJobActive();
    }

    if (millis() - lastHeartbeatLog >= 10000UL) {
        lastHeartbeatLog = millis();
        logStateSnapshot("[LOOP] Alive");
    }

    yield();
}

void Coordinator::_syncIdleState() {
    const unsigned long now = millis();

    if (g_system.portalActive) {
        if (g_system.state != STATE_WIFI_SETUP) {
            stateSet(STATE_WIFI_SETUP);
            g_mqttManager.publishStatus(true);
        }
        return;
    }

    if ((g_system.state == STATE_SUCCESS || g_system.state == STATE_ERROR) &&
        g_system.stateHoldUntil != 0 &&
        ((long)(now - g_system.stateHoldUntil) < 0)) {
        return;
    }

    if (g_system.state != STATE_IDLE) {
        if (g_system.state == STATE_ERROR) {
            clearLastError();
        }
        g_system.stateHoldUntil = 0;
        stateSet(STATE_IDLE);
        g_mqttManager.publishStatus(true);
    }
}

void Coordinator::_handleLegacyReadMode() {
    const unsigned long now = millis();

    if ((g_system.state == STATE_SUCCESS || g_system.state == STATE_ERROR) &&
        g_system.stateHoldUntil != 0 &&
        ((long)(now - g_system.stateHoldUntil) < 0)) {
        return;
    }

    if (now < _legacyCooldownUntil) {
        return;
    }

    if (g_system.state != STATE_IDLE) {
        g_system.stateHoldUntil = 0;
        stateSet(STATE_IDLE);
    }

    if ((now - g_system.lastNfcPoll) < NFC_POLL_INTERVAL_MS) {
        return;
    }
    g_system.lastNfcPoll = now;

    if (!g_nfcManager.tagPresent()) {
        return;
    }

    Serial.println(F("[NFC] Legacy read mode detected a tag"));
    stateSet(STATE_NFC_ACTIVE);
    g_lcd.forceUpdate();
    lcdSuspendUpdates();

    NfcCardInfo card;
    String error;
    const bool success = g_nfcManager.readTag(card, &error);
    g_system.lastCard = card;
    g_system.lastCompletedCommand = NFC_CMD_READ;

    const String requestId = String("legacy-") + String(millis());
    if (success) {
        clearLastError();
        g_mqttManager.publishReadResult(card, requestId);
        stateSet(STATE_SUCCESS);
    } else {
        const String errorCode = extractErrorCode(error, NFC_CMD_READ);
        const String message = extractErrorMessage(error, NFC_CMD_READ);
        setLastError("nfc", errorCode, message);
        g_mqttManager.publishHardwareError("nfc", errorCode, message, requestId);
    }

    g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
    lcdResumeUpdates();
    g_lcd.forceUpdate();
    g_mqttManager.publishStatus(true);
    _legacyCooldownUntil = millis() + 1500UL;
}

bool Coordinator::_jobTimedOut(unsigned long now) const {
    return g_system.nfcJob.active &&
           (now - g_system.nfcJob.startedAt) >= g_system.nfcJob.timeoutMs;
}

void Coordinator::_prepareActiveJob() {
    if (!g_system.nfcJob.active) {
        return;
    }

    if (_observedJobStartedAt == g_system.nfcJob.startedAt) {
        return;
    }
    _observedJobStartedAt = g_system.nfcJob.startedAt;

    Serial.print(F("[NFC] Job prepared type="));
    Serial.print(nfcCommandName(g_system.nfcJob.command));
    Serial.print(F(" requestId="));
    Serial.print(g_system.nfcJob.requestId);
    Serial.print(F(" timeoutMs="));
    Serial.println(g_system.nfcJob.timeoutMs);

    stateSet(STATE_NFC_WAITING);
    g_lcd.forceUpdate();
    lcdSuspendUpdates();
    g_mqttManager.publishStatus(true);
}

void Coordinator::_handleNfcJob() {
    _prepareActiveJob();

    const unsigned long now = millis();
    if (_jobTimedOut(now)) {
        _handleNfcTimeout();
        return;
    }

    if ((now - g_system.lastNfcPoll) < NFC_POLL_INTERVAL_MS) {
        return;
    }
    g_system.lastNfcPoll = now;

    if (!g_nfcManager.tagPresent()) {
        return;
    }

    Serial.println(F("[NFC] Tag detected, starting operation"));
    stateSet(STATE_NFC_ACTIVE);

    NfcCardInfo card;
    String error;
    bool success = false;

    if (g_system.nfcJob.command == NFC_CMD_WRITE) {
        success = g_nfcManager.writeTag(
            g_system.nfcJob.url,
            g_system.nfcJob.lockCard,
            card,
            &error
        );
    } else if (g_system.nfcJob.command == NFC_CMD_READ) {
        success = g_nfcManager.readTag(card, &error);
    } else {
        error = "invalid_command|Unsupported NFC command";
    }

    g_system.lastCard = card;

    if (success) {
        _completeNfcSuccess(card);
        return;
    }

    _completeNfcError(error);
}

void Coordinator::_completeNfcSuccess(const NfcCardInfo& card) {
    Serial.print(F("[NFC] Success command="));
    Serial.print(nfcCommandName(g_system.nfcJob.command));
    Serial.print(F(" uid="));
    Serial.println(card.uid);

    g_system.lastCard = card;
    g_system.lastCompletedCommand = g_system.nfcJob.command;
    clearLastError();

    const NfcCommandType command = g_system.nfcJob.command;
    const String requestId = g_system.nfcJob.requestId;
    const String url = g_system.nfcJob.url;

    if (command == NFC_CMD_WRITE) {
        g_mqttManager.publishWriteResult(card, requestId, url, true);
    } else {
        g_mqttManager.publishReadResult(card, requestId);
    }

    _finishJob(STATE_SUCCESS);
}

void Coordinator::_completeNfcError(const String& error) {
    const NfcCommandType command = g_system.nfcJob.command;
    const String requestId = g_system.nfcJob.requestId;
    const String url = g_system.nfcJob.url;

    const String errorCode = extractErrorCode(error, command);
    const String message = extractErrorMessage(error, command);

    Serial.print(F("[NFC] Error command="));
    Serial.print(nfcCommandName(command));
    Serial.print(F(" code="));
    Serial.print(errorCode);
    Serial.print(F(" message="));
    Serial.println(message);

    g_system.lastCompletedCommand = command;
    setLastError("nfc", errorCode, message);

    if (command == NFC_CMD_WRITE) {
        g_mqttManager.publishWriteResult(
            g_system.lastCard,
            requestId,
            url,
            false,
            errorCode,
            message
        );
    } else {
        g_mqttManager.publishHardwareError("nfc", errorCode, message, requestId);
    }

    _finishJob(STATE_ERROR);
}

void Coordinator::_handleNfcTimeout() {
    const unsigned long now = millis();
    const unsigned long elapsedMs = now - g_system.nfcJob.startedAt;

    Serial.print(F("[NFC] Timeout command="));
    Serial.print(nfcCommandName(g_system.nfcJob.command));
    Serial.print(F(" elapsedMs="));
    Serial.println(elapsedMs);

    g_system.lastCompletedCommand = g_system.nfcJob.command;
    setLastError("nfc", "timeout", "No NFC tag detected before timeout");
    g_nfcManager.haltTag();

    if (!g_system.nfcJob.timeoutReported) {
        g_mqttManager.publishNfcTimeout(
            g_system.nfcJob.requestId,
            g_system.nfcJob.command,
            g_system.nfcJob.timeoutMs,
            elapsedMs
        );
        g_system.nfcJob.timeoutReported = true;
    }

    _finishJob(STATE_ERROR);
}

void Coordinator::_finishJob(DeviceState finalState) {
    Serial.print(F("[NFC] Finish job finalState="));
    Serial.println(deviceStateName(finalState));

    lcdResumeUpdates();
    stateSet(finalState);
    g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
    clearNfcJob();
    _observedJobStartedAt = 0;

    g_lcd.forceUpdate();
    g_mqttManager.publishStatus(true);
}
