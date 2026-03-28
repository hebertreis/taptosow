/**
 * @file mqtt_manager.cpp
 * @brief MQTT client manager implementation for OneTapGo
 */

#include "managers/mqtt_manager.h"
#include "managers/lcd_manager.h"
#include "managers/status_led_manager.h"
#include "managers/wifi_manager.h"

#include <cstring>

namespace {

constexpr size_t kCommandJsonSize = 384;
constexpr size_t kResultJsonSize = 896;
constexpr size_t kStatusPayloadSize = 640;
constexpr size_t kHeartbeatPayloadSize = 256;
constexpr size_t kResultPayloadSize = 1024;

String makeOfflineStatusPayload() {
    StaticJsonDocument<128> doc;
    doc["type"] = "status";
    doc["deviceId"] = g_system.deviceId;
    doc["state"] = "offline";
    doc["ready"] = false;
    doc["wifiConnected"] = false;
    doc["mqttConnected"] = false;
    doc["nfcReady"] = g_system.isNfcConnected;
    doc["timestamp"] = millis();

    String payload;
    payload.reserve(measureJson(doc) + 1);
    serializeJson(doc, payload);
    return payload;
}

void addBaseResultFields(JsonDocument& doc,
                         const char* resultType,
                         const String& requestId,
                         const String& command,
                         bool success) {
    doc["type"] = resultType;
    doc["deviceId"] = g_system.deviceId;
    doc["requestId"] = requestId;
    doc["command"] = command;
    doc["success"] = success;
    doc["state"] = deviceStateName(stateGet());
    doc["timestamp"] = millis();
    doc["uptime"] = millis();
    doc["freeHeap"] = ESP.getFreeHeap();
}

bool parseBoolValue(JsonVariantConst value, bool defaultValue) {
    if (value.isNull()) {
        return defaultValue;
    }
    if (value.is<bool>()) {
        return value.as<bool>();
    }
    if (value.is<int>()) {
        return value.as<int>() != 0;
    }
    if (value.is<const char*>()) {
        String text = value.as<const char*>();
        text.trim();
        text.toLowerCase();
        if (text == "true" || text == "1" || text == "yes" || text == "on") {
            return true;
        }
        if (text == "false" || text == "0" || text == "no" || text == "off") {
            return false;
        }
    }
    return defaultValue;
}

bool workflowBusy() {
    if (nfcJobActive()) {
        return true;
    }

    if ((g_system.state == STATE_SUCCESS || g_system.state == STATE_ERROR) &&
        g_system.stateHoldUntil != 0 &&
        ((long)(millis() - g_system.stateHoldUntil) < 0)) {
        return true;
    }

    return false;
}

} // namespace

MqttManager g_mqttManager;

void mqttCallbackWrapper(char* topic, byte* payload, unsigned int length) {
    g_mqttManager._handleMessage(topic, payload, length);
}

void MqttManager::begin(const String& deviceId, const String& mqttTopicBase) {
    _deviceId = deviceId;
    _mqttTopicBase = mqttTopicBase;
    _statusTopic = _mqttTopicBase + "/status";
    _heartbeatTopic = _mqttTopicBase + "/heartbeat";
    _commandTopic = _mqttTopicBase + "/command";
    _resultTopic = _mqttTopicBase + "/result";
    _lastHeartbeat = 0;
    _lastReconnect = 0;
    _reconnectAttempts = 0;

    if (MQTT_USE_TLS) {
        g_wifiClient.setInsecure();
    }
    g_wifiClient.setTimeout(MQTT_SOCKET_TIMEOUT_SEC);

    g_mqttClient.setClient(g_wifiClient);
    g_mqttClient.setServer(MQTT_HOST, MQTT_PORT);
    g_mqttClient.setCallback(mqttCallbackWrapper);
    g_mqttClient.setBufferSize(MQTT_BUFFER_SIZE_BYTES);
    g_mqttClient.setKeepAlive(MQTT_KEEPALIVE_SEC);
    g_mqttClient.setSocketTimeout(MQTT_SOCKET_TIMEOUT_SEC);

    g_system.isMqttConnected = false;

    Serial.print(F("[MQTT] begin deviceId="));
    Serial.print(_deviceId);
    Serial.print(F(" topicBase="));
    Serial.println(_mqttTopicBase);

    if (g_system.isWifiConnected) {
        connect();
    }
}

void MqttManager::loop() {
    const unsigned long now = millis();

    if (!g_mqttClient.connected()) {
        if (g_system.isMqttConnected) {
            g_system.isMqttConnected = false;
        }
        connect();
        return;
    }

    g_system.isMqttConnected = true;
    g_mqttClient.loop();
    _publishPendingWifiSetResult();

    if (now - _lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        publishHeartbeat();
    }
}

bool MqttManager::connect() {
    if (g_mqttClient.connected()) {
        g_system.isMqttConnected = true;
        return true;
    }

    if (!g_system.isWifiConnected) {
        g_system.isMqttConnected = false;
        return false;
    }

    const unsigned long now = millis();
    if (_lastReconnect != 0 && (now - _lastReconnect) < MQTT_RECONNECT_DELAY_MS) {
        return false;
    }
    _lastReconnect = now;
    g_system.lastReconnectAttempt = now;

    const String willTopic = _statusTopic;
    const String willPayload = makeOfflineStatusPayload();
    Serial.print(F("[MQTT] Connecting host="));
    Serial.print(MQTT_HOST);
    Serial.print(F(" port="));
    Serial.print(MQTT_PORT);
    Serial.print(F(" clientId="));
    Serial.println(_deviceId);
    const bool connected = g_mqttClient.connect(
        _deviceId.c_str(),
        MQTT_USERNAME,
        MQTT_PASSWORD,
        willTopic.c_str(),
        1,
        true,
        willPayload.c_str()
    );

    if (!connected) {
        Serial.print(F("[MQTT] Connect failed state="));
        Serial.println(g_mqttClient.state());
        g_system.isMqttConnected = false;
        if (_reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            ++_reconnectAttempts;
        }
        return false;
    }

    _reconnectAttempts = 0;
    g_system.isMqttConnected = true;

    g_mqttClient.subscribe(_commandTopic.c_str(), 1);
    Serial.print(F("[MQTT] Connected, subscribed "));
    Serial.println(_commandTopic);

    publishStatus(true);
    return true;
}

bool MqttManager::isConnected() {
    return g_mqttClient.connected();
}

bool MqttManager::publish(const String& topic, const String& payload, bool retained) {
    return publish(topic, payload.c_str(), retained);
}

bool MqttManager::publish(const String& topic, const char* payload, bool retained) {
    if (!g_mqttClient.connected()) {
        Serial.print(F("[MQTT] Skip publish disconnected topic="));
        Serial.println(topic);
        g_system.isMqttConnected = false;
        return false;
    }

    Serial.print(F("[MQTT] Publish topic="));
    Serial.print(topic);
    Serial.print(F(" bytes="));
    Serial.print(payload != nullptr ? strlen(payload) : 0);
    Serial.print(F(" retained="));
    Serial.println(retained ? F("1") : F("0"));

    const bool ok = g_mqttClient.publish(topic.c_str(), payload != nullptr ? payload : "", retained);
    if (!ok) {
        Serial.print(F("[MQTT] Publish failed state="));
        Serial.println(g_mqttClient.state());
        g_system.isMqttConnected = g_mqttClient.connected();
    } else {
        g_statusLed.signalActivity();
    }
    return ok;
}

bool MqttManager::_publishDoc(const String& topic, JsonDocument& doc, bool retained) {
    char payload[kResultPayloadSize] = {0};
    const size_t length = serializeJson(doc, payload, sizeof(payload));
    if (length == 0 || length >= sizeof(payload)) {
        Serial.println(F("[MQTT] Failed to serialize JSON payload"));
        return false;
    }
    return publish(topic, payload, retained);
}

void MqttManager::publishStatus(bool retained) {
    char payload[kStatusPayloadSize] = {0};
    const size_t length = serializeStatusJson(payload, sizeof(payload));
    if (length == 0 || length >= sizeof(payload)) {
        Serial.println(F("[MQTT] Failed to serialize status payload"));
        return;
    }
    publish(_statusTopic, payload, retained);
}

void MqttManager::publishHeartbeat() {
    _lastHeartbeat = millis();
    g_system.lastHeartbeat = _lastHeartbeat;
    char payload[kHeartbeatPayloadSize] = {0};
    const size_t length = serializeHeartbeatJson(payload, sizeof(payload));
    if (length == 0 || length >= sizeof(payload)) {
        Serial.println(F("[MQTT] Failed to serialize heartbeat payload"));
        return;
    }
    publish(_heartbeatTopic, payload, false);
}

void MqttManager::publishReadResult(const NfcCardInfo& card, const String& requestId) {
    StaticJsonDocument<kResultJsonSize> doc;
    addBaseResultFields(doc, "tag_read", requestId, "read", true);
    doc["uid"] = card.uid;
    doc["tagType"] = card.piccTypeName;
    doc["family"] = card.family;
    doc["brand"] = card.brand;
    doc["capacityBytes"] = card.capacityBytes;
    doc["ndefUrl"] = card.ndefUrl;
    doc["hasNdef"] = card.hasNdef;
    doc["code"] = "ok";
    _publishDoc(_resultTopic, doc, false);
}

void MqttManager::publishWriteResult(const NfcCardInfo& card,
                                     const String& requestId,
                                     const String& writtenUrl,
                                     bool success,
                                     const String& errorCode,
                                     const String& message) {
    StaticJsonDocument<kResultJsonSize> doc;
    addBaseResultFields(doc, success ? "write_success" : "write_error", requestId, "write", success);
    doc["uid"] = card.uid;
    doc["tagType"] = card.piccTypeName;
    doc["family"] = card.family;
    doc["brand"] = card.brand;
    doc["capacityBytes"] = card.capacityBytes;
    doc["writtenUrl"] = writtenUrl;
    doc["lockRequested"] = card.lockRequested;
    doc["lockApplied"] = card.lockApplied;

    if (!success) {
        doc["code"] = errorCode;
        doc["message"] = message;
    } else if (message.length() > 0) {
        doc["code"] = "ok";
        doc["message"] = message;
    } else {
        doc["code"] = "ok";
    }
    _publishDoc(_resultTopic, doc, false);
}

void MqttManager::publishNfcTimeout(const String& requestId,
                                    NfcCommandType command,
                                    unsigned long timeoutMs,
                                    unsigned long elapsedMs) {
    StaticJsonDocument<kResultJsonSize> doc;
    addBaseResultFields(doc, "nfc_timeout", requestId, nfcCommandName(command), false);
    doc["code"] = "nfc_timeout";
    doc["message"] = "No NFC tag was presented before the timeout expired";
    doc["timeoutMs"] = timeoutMs;
    doc["elapsedMs"] = elapsedMs;
    _publishDoc(_resultTopic, doc, false);
}

void MqttManager::publishHardwareError(const String& source,
                                       const String& errorCode,
                                       const String& message,
                                       const String& requestId) {
    StaticJsonDocument<kResultJsonSize> doc;
    const String command = nfcJobActive()
        ? nfcCommandName(g_system.nfcJob.command)
        : String("none");
    addBaseResultFields(doc, "hardware_error", requestId, command, false);
    doc["source"] = source;
    doc["code"] = errorCode;
    doc["message"] = message;
    if (nfcJobActive()) {
        doc["activeRequestId"] = g_system.nfcJob.requestId;
        doc["activeCommand"] = nfcCommandName(g_system.nfcJob.command);
        doc["activeTimeoutMs"] = g_system.nfcJob.timeoutMs;
    }
    _publishDoc(_resultTopic, doc, false);
}

void MqttManager::setDebugMode(bool enabled) {
    g_system.debugMode = enabled;
}

void MqttManager::setLegacyReadMode(bool enabled) {
    g_system.legacyReadMode = enabled;
}

void MqttManager::_handleMessage(char* topic, byte* payload, unsigned int length) {
    if (topic == nullptr || payload == nullptr) {
        if (!workflowBusy()) {
            setLastError("mqtt", "invalid_message", "MQTT callback received null topic or payload");
            g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
            g_lcd.forceUpdate();
        }
        publishHardwareError("mqtt", "invalid_message", "MQTT callback received null topic or payload");
        publishStatus(true);
        return;
    }

    if (strcmp(topic, _commandTopic.c_str()) != 0) {
        return;
    }

    Serial.print(F("[MQTT] RX topic="));
    Serial.print(topic);
    Serial.print(F(" bytes="));
    Serial.println(length);
    g_statusLed.signalActivity();

    StaticJsonDocument<kCommandJsonSize> doc;
    DeserializationError error = deserializeJson(doc, payload, length);
    if (error) {
        Serial.print(F("[MQTT] JSON error="));
        Serial.println(error.c_str());
        if (!workflowBusy()) {
            setLastError("mqtt", "invalid_json", error.c_str());
            g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
            g_lcd.forceUpdate();
        }
        publishHardwareError("mqtt", "invalid_json", error.c_str());
        publishStatus(true);
        return;
    }

    const char* commandType = doc["type"] | doc["command"] | doc["action"] | "";
    Serial.print(F("[MQTT] Command="));
    Serial.println(commandType);
    if (strcmp(commandType, "write") == 0 || strcmp(commandType, "write_tag") == 0) {
        _handleWrite(doc);
        return;
    }
    if (strcmp(commandType, "read") == 0 || strcmp(commandType, "read_tag") == 0) {
        _handleRead(doc);
        return;
    }
    if (strcmp(commandType, "status") == 0) {
        _handleStatus();
        return;
    }
    if (strcmp(commandType, "restart") == 0) {
        _handleRestart();
        return;
    }
    if (strcmp(commandType, "set_debug") == 0) {
        _handleSetDebug(doc);
        return;
    }
    if (strcmp(commandType, "set_read_mode") == 0) {
        _handleSetReadMode(doc);
        return;
    }
    if (strcmp(commandType, "wifi_scan") == 0) {
        _handleWifiScan(doc);
        return;
    }
    if (strcmp(commandType, "wifi_set") == 0) {
        _handleWifiSet(doc);
        return;
    }
    if (strcmp(commandType, "wifi_reset") == 0) {
        _handleWifiReset(doc);
        return;
    }
    if (strcmp(commandType, "wifi_portal") == 0) {
        _handleWifiPortal(doc);
        return;
    }

    publishHardwareError(
        "mqtt",
        "unsupported_command",
        String("Unsupported MQTT command: ") + commandType,
        _requestIdFromDoc(doc)
    );
    if (!workflowBusy()) {
        setLastError("mqtt", "unsupported_command", String("Unsupported MQTT command: ") + commandType);
        g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
        g_lcd.forceUpdate();
    }
    publishStatus(true);
}

bool MqttManager::_isValidUri(const String& url) {
    String value = url;
    value.trim();
    if (value.length() == 0 || value.length() > NDEF_URI_MAX_LENGTH) {
        return false;
    }
    if (!(value.startsWith("http://") || value.startsWith("https://"))) {
        return false;
    }
    return value.indexOf(' ') < 0;
}

unsigned long MqttManager::_clampTimeout(JsonDocument& doc, unsigned long defaultTimeoutMs) {
    unsigned long timeoutMs = defaultTimeoutMs;
    JsonVariantConst timeoutValue = doc["timeoutSec"];
    if (!timeoutValue.isNull()) {
        unsigned long timeoutSec = 0;
        if (timeoutValue.is<unsigned long>()) {
            timeoutSec = timeoutValue.as<unsigned long>();
        } else if (timeoutValue.is<long>()) {
            const long parsed = timeoutValue.as<long>();
            timeoutSec = parsed > 0 ? static_cast<unsigned long>(parsed) : 0;
        } else if (timeoutValue.is<const char*>()) {
            timeoutSec = String(timeoutValue.as<const char*>()).toInt();
        }

        if (timeoutSec > 0) {
            timeoutMs = timeoutSec * 1000UL;
        }
    }

    const unsigned long minTimeoutMs = NFC_MIN_COMMAND_TIMEOUT_SEC * 1000UL;
    const unsigned long maxTimeoutMs = NFC_MAX_COMMAND_TIMEOUT_SEC * 1000UL;
    if (timeoutMs < minTimeoutMs) {
        timeoutMs = minTimeoutMs;
    }
    if (timeoutMs > maxTimeoutMs) {
        timeoutMs = maxTimeoutMs;
    }
    return timeoutMs;
}

String MqttManager::_requestIdFromDoc(JsonDocument& doc) {
    const char* requestId = doc["requestId"] | "";
    String value(requestId);
    value.trim();
    if (value.length() > 0) {
        return value;
    }
    return g_system.deviceId + "-" + String(millis());
}

void MqttManager::_handleWrite(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    String url = String(doc["url"] | "");
    url.trim();

    Serial.print(F("[MQTT] Handle write requestId="));
    Serial.print(requestId);
    Serial.print(F(" url="));
    Serial.println(url);

    if (!_isValidUri(url)) {
        if (!workflowBusy()) {
            setLastError("mqtt", "invalid_url", "Write requires an http:// or https:// URL payload");
            g_system.stateHoldUntil = millis() + LCD_HOLD_INTERVAL_MS;
            g_lcd.forceUpdate();
        }
        publishWriteResult(NfcCardInfo(), requestId, url, false, "invalid_url",
                           "Write requires an http:// or https:// URL payload");
        return;
    }

    if (workflowBusy()) {
        publishWriteResult(NfcCardInfo(), requestId, url, false, "busy",
                           "An NFC job is already active");
        return;
    }

    const unsigned long timeoutMs = _clampTimeout(doc, NFC_DEFAULT_COMMAND_TIMEOUT_SEC * 1000UL);
    const bool lockCard = parseBoolValue(doc["lock"], false);

    Serial.print(F("[MQTT] Write job queued timeoutMs="));
    Serial.print(timeoutMs);
    Serial.print(F(" lock="));
    Serial.println(lockCard ? F("1") : F("0"));

    startNfcJob(NFC_CMD_WRITE, requestId, url, timeoutMs, lockCard);
}

void MqttManager::_handleRead(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    Serial.print(F("[MQTT] Handle read requestId="));
    Serial.println(requestId);
    if (workflowBusy()) {
        publishHardwareError("nfc", "busy", "An NFC job is already active", requestId);
        return;
    }

    const unsigned long timeoutMs = _clampTimeout(doc, NFC_DEFAULT_COMMAND_TIMEOUT_SEC * 1000UL);
    Serial.print(F("[MQTT] Read job queued timeoutMs="));
    Serial.println(timeoutMs);
    startNfcJob(NFC_CMD_READ, requestId, "", timeoutMs, false);
}

void MqttManager::_handleStatus() {
    publishStatus(true);
    publishHeartbeat();
}

void MqttManager::_handleRestart() {
    publishStatus(true);
    ESP.restart();
}

void MqttManager::_handleSetDebug(JsonDocument& doc) {
    setDebugMode(parseBoolValue(doc["enabled"], g_system.debugMode));
    publishStatus(true);
}

void MqttManager::_handleSetReadMode(JsonDocument& doc) {
    setLegacyReadMode(parseBoolValue(doc["enabled"], g_system.legacyReadMode));
    publishStatus(true);
}

void MqttManager::_handleWifiScan(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    StaticJsonDocument<kResultJsonSize> result;
    addBaseResultFields(result, "wifi_scan_result", requestId, "wifi_scan", true);
    JsonArray networks = result.createNestedArray("networks");
    bool truncated = false;
    const bool ok = g_wifiManager.scanNetworks(networks, truncated);
    result["truncated"] = truncated;

    if (!ok) {
        result["success"] = false;
        result["code"] = "wifi_scan_failed";
        result["message"] = "Nao foi possivel listar redes";
    } else {
        result["count"] = networks.size();
        result["code"] = "ok";
    }
    _publishDoc(_resultTopic, result, false);
}

void MqttManager::_handleWifiSet(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    String ssid = String(doc["ssid"] | "");
    String password = String(doc["password"] | "");
    ssid.trim();

    if (ssid.length() == 0) {
        publishHardwareError("wifi", "invalid_ssid", "SSID obrigatorio", requestId);
        return;
    }

    StaticJsonDocument<256> ack;
    addBaseResultFields(ack, "wifi_set_ack", requestId, "wifi_set", true);
    ack["stage"] = "switching";
    ack["ssid"] = ssid;
    _publishDoc(_resultTopic, ack, false);

    const unsigned long timeoutSec = doc["timeoutSec"] | WIFI_COMMAND_CONNECT_TIMEOUT_SEC;
    const bool portalOnFail = parseBoolValue(doc["portalOnFail"], true);
    String errorMessage;

    const bool success = g_wifiManager.applyCredentials(
        ssid,
        password,
        timeoutSec * 1000UL,
        portalOnFail,
        errorMessage
    );

    _pendingWifiSetResult = true;
    _pendingWifiSetSuccess = success;
    _pendingWifiSetPortalActive = g_system.portalActive;
    _pendingWifiSetRequestId = requestId;
    _pendingWifiSetSsid = ssid;
    _pendingWifiSetMessage = success ? String("WiFi atualizado") :
                                       (errorMessage.length() > 0 ? errorMessage : String("Falha ao trocar WiFi"));

    if (g_system.isWifiConnected) {
        connect();
        _publishPendingWifiSetResult();
    }
}

void MqttManager::_handleWifiReset(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    const bool startPortal = parseBoolValue(doc["startPortal"], true);
    String errorMessage;
    const bool success = g_wifiManager.resetCredentials(startPortal, errorMessage);

    StaticJsonDocument<384> result;
    addBaseResultFields(result, "wifi_reset_result", requestId, "wifi_reset", success);
    result["portalActive"] = g_system.portalActive;
    result["portalSsid"] = g_system.portalApSsid;
    if (!success) {
        result["code"] = "wifi_reset_failed";
        result["message"] = errorMessage;
    } else {
        result["code"] = "ok";
    }
    _publishDoc(_resultTopic, result, false);
}

void MqttManager::_handleWifiPortal(JsonDocument& doc) {
    const String requestId = _requestIdFromDoc(doc);
    const bool enabled = parseBoolValue(doc["enabled"], true);

    StaticJsonDocument<384> result;
    if (!enabled) {
        addBaseResultFields(result, "wifi_portal_result", requestId, "wifi_portal", true);
        result["portalActive"] = false;
        result["portalSsid"] = g_system.portalApSsid;
        result["code"] = "noop";
        _publishDoc(_resultTopic, result, false);
        return;
    }

    addBaseResultFields(result, "wifi_portal_result", requestId, "wifi_portal", true);
    result["portalActive"] = true;
    result["portalSsid"] = g_system.portalApSsid;
    result["code"] = "opening";
    _publishDoc(_resultTopic, result, false);

    const unsigned long timeoutSec = doc["timeoutSec"] | WIFI_CONFIG_PORTAL_TIMEOUT_SEC;
    String errorMessage;
    g_wifiManager.openConfigPortal(timeoutSec, errorMessage);
}

void MqttManager::_publishPendingWifiSetResult() {
    if (!_pendingWifiSetResult || !g_mqttClient.connected()) {
        return;
    }

    StaticJsonDocument<384> result;
    addBaseResultFields(result, "wifi_set_result", _pendingWifiSetRequestId, "wifi_set", _pendingWifiSetSuccess);
    result["ssid"] = _pendingWifiSetSsid;
    result["portalActive"] = g_system.portalActive;
    result["portalSsid"] = g_system.portalApSsid;
    result["ip"] = g_system.wifiIp;
    if (_pendingWifiSetSuccess) {
        result["code"] = "ok";
    } else {
        result["code"] = "wifi_set_failed";
        result["message"] = _pendingWifiSetMessage;
    }

    if (_publishDoc(_resultTopic, result, false)) {
        _pendingWifiSetResult = false;
        _pendingWifiSetRequestId = "";
        _pendingWifiSetSsid = "";
        _pendingWifiSetMessage = "";
    }
}
