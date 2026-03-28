/**
 * @file wifi_manager.cpp
 * @brief WiFi manager implementation
 */

#include "managers/wifi_manager.h"
#include "managers/lcd_manager.h"
#include "core/system_state.h"

WifiManager g_wifiManager;

namespace {
int wifiQualityFromRssi(int rssi) {
    if (rssi <= -100) return 0;
    if (rssi >= -50) return 100;
    return 2 * (rssi + 100);
}
}

bool WifiManager::begin() {
    Serial.println(F("\n[WiFi] Initializing..."));

    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    
    // Generate device ID from MAC address
    uint8_t mac[6];
    WiFi.macAddress(mac);
    g_system.deviceId = String(MQTT_CLIENT_PREFIX) + "_" +
                        String(mac[4], HEX) +
                        String(mac[5], HEX);
    g_system.mqttTopicBase = "onetapgo/" + g_system.deviceId;
    g_system.portalApSsid = String(WIFI_AP_PREFIX) + g_system.deviceId.substring(g_system.deviceId.length() > 6 ? g_system.deviceId.length() - 6 : 0);
    g_system.portalApPassword = WIFI_AP_PASSWORD;
    
    Serial.print(F("[WiFi] Device ID: "));
    Serial.println(g_system.deviceId);
    
    _configureManager(WIFI_CONFIG_PORTAL_TIMEOUT_SEC);

    String apSSID = g_system.portalApSsid;
    const char* apPassword = g_system.portalApPassword.c_str();

    if (!_wifiManager.autoConnect(apSSID.c_str(), apPassword)) {
        Serial.println(F("[WiFi] Failed to connect, restarting..."));
        _setPortalState(true, true);
        g_system.isWifiConnected = false;
        g_lcd.showMessage("WiFi Error", "Restarting...", 3000);
        ESP.restart();
        return false;
    }

    _connected = true;
    _setPortalState(false, false);
    _updateStatusFromWiFi();
    stateSet(STATE_IDLE);

    Serial.println(F("[WiFi] Connected successfully"));
    Serial.print(F("[WiFi] IP address: "));
    Serial.println(g_system.wifiIp);

    return true;
}

void WifiManager::loop() {
    if (WiFi.status() == WL_CONNECTED) {
        if (g_system.accessPointActive && !g_system.portalActive) {
            _stopFallbackPortal();
        }
        if (!_connected || !g_system.isWifiConnected) {
            _connected = true;
            _updateStatusFromWiFi();
        } else {
            _updateStatusFromWiFi();
        }
        return;
    }

    if (_connected || g_system.isWifiConnected) {
        Serial.println(F("[WiFi] Connection lost"));
    }

    _connected = false;
    g_system.isWifiConnected = false;
    g_system.wifiSsid = "";
    g_system.wifiIp = "";
    g_system.wifiRssi = WiFi.RSSI();

    if (millis() - _lastReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS) {
        _lastReconnectAttempt = millis();
        WiFi.reconnect();
        if (WiFi.status() != WL_CONNECTED) {
            _startFallbackPortal();
        }
    }
}

bool WifiManager::isConnected() {
    return (WiFi.status() == WL_CONNECTED) && _connected;
}

String WifiManager::getIPAddress() {
    return g_system.wifiIp.length() > 0 ? g_system.wifiIp : WiFi.localIP().toString();
}

int WifiManager::getRSSI() {
    return g_system.wifiRssi;
}

String WifiManager::getSSID() {
    return g_system.wifiSsid;
}

String WifiManager::getPortalSSID() {
    return g_system.portalApSsid;
}

bool WifiManager::scanNetworks(JsonArray networks, bool& truncated) {
    truncated = false;
    const int found = WiFi.scanNetworks();
    if (found < 0) {
        return false;
    }

    int bestIndex[WIFI_SCAN_RESULT_LIMIT];
    int bestRssi[WIFI_SCAN_RESULT_LIMIT];
    for (int i = 0; i < WIFI_SCAN_RESULT_LIMIT; ++i) {
        bestIndex[i] = -1;
        bestRssi[i] = -1000;
    }

    for (int i = 0; i < found; ++i) {
        const int rssi = WiFi.RSSI(i);
        for (int slot = 0; slot < WIFI_SCAN_RESULT_LIMIT; ++slot) {
            if (rssi > bestRssi[slot]) {
                for (int move = WIFI_SCAN_RESULT_LIMIT - 1; move > slot; --move) {
                    bestIndex[move] = bestIndex[move - 1];
                    bestRssi[move] = bestRssi[move - 1];
                }
                bestIndex[slot] = i;
                bestRssi[slot] = rssi;
                break;
            }
        }
    }

    for (int i = 0; i < WIFI_SCAN_RESULT_LIMIT; ++i) {
        if (bestIndex[i] < 0) {
            continue;
        }
        JsonObject entry = networks.createNestedObject();
        entry["ssid"] = WiFi.SSID(bestIndex[i]);
        entry["rssi"] = WiFi.RSSI(bestIndex[i]);
        entry["quality"] = wifiQualityFromRssi(WiFi.RSSI(bestIndex[i]));
        entry["secure"] = WiFi.encryptionType(bestIndex[i]) != ENC_TYPE_NONE;
        entry["channel"] = WiFi.channel(bestIndex[i]);
    }

    truncated = found > WIFI_SCAN_RESULT_LIMIT;
    WiFi.scanDelete();
    return true;
}

bool WifiManager::applyCredentials(const String& ssid,
                                   const String& password,
                                   unsigned long timeoutMs,
                                   bool portalOnFail,
                                   String& errorMessage) {
    errorMessage = "";
    if (ssid.length() == 0) {
        errorMessage = "SSID vazio";
        return false;
    }

    g_system.wifiReconfigPending = true;
    g_system.lastWifiError = "";
    _stopFallbackPortal();

    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), password.c_str());
    const bool connected = _waitForConnection(timeoutMs);
    _updateStatusFromWiFi();

    if (!connected) {
        errorMessage = "Falha ao conectar no novo WiFi";
        g_system.lastWifiError = errorMessage;
        g_system.wifiReconfigPending = false;
        if (portalOnFail) {
            String portalError;
            openConfigPortal(WIFI_CONFIG_PORTAL_TIMEOUT_SEC, portalError);
            if (portalError.length() > 0 && errorMessage.length() == 0) {
                errorMessage = portalError;
            }
        }
        return false;
    }

    g_system.wifiReconfigPending = false;
    return true;
}

bool WifiManager::resetCredentials(bool startPortal, String& errorMessage) {
    errorMessage = "";
    g_system.wifiReconfigPending = false;
    _wifiManager.resetSettings();
    WiFi.disconnect(true);
    delay(100);
    _connected = false;
    _updateStatusFromWiFi();

    if (startPortal) {
        return openConfigPortal(WIFI_CONFIG_PORTAL_TIMEOUT_SEC, errorMessage);
    }

    return true;
}

bool WifiManager::openConfigPortal(unsigned long timeoutSec, String& errorMessage) {
    errorMessage = "";
    _configureManager(timeoutSec);

    const String apSSID = g_system.portalApSsid;
    const char* apPassword = g_system.portalApPassword.c_str();

    _portalRunning = true;
    const bool connected = _wifiManager.startConfigPortal(apSSID.c_str(), apPassword);
    _portalRunning = false;

    if (!connected && WiFi.status() != WL_CONNECTED) {
        _setPortalState(false, false);
        g_system.lastWifiError = "Portal encerrado sem conexao";
        errorMessage = g_system.lastWifiError;
        stateSet(STATE_IDLE);
        return false;
    }

    _setPortalState(false, false);
    _updateStatusFromWiFi();
    g_system.wifiReconfigPending = false;
    stateSet(STATE_IDLE);
    return true;
}

void WifiManager::_configureManager(unsigned long timeoutSec) {
    _wifiManager.setConfigPortalTimeout(timeoutSec);
    _wifiManager.setConnectTimeout(WIFI_CONNECT_TIMEOUT_SEC);
    _wifiManager.setDebugOutput(false);
    _wifiManager.setBreakAfterConfig(true);
    _wifiManager.setAPCallback([](WiFiManager* wm) {
        Serial.println(F("[WiFi] Configuration portal started"));
        g_wifiManager._setPortalState(true, true);
        stateSet(STATE_WIFI_SETUP);
        g_lcd.showQrCode(wm->getConfigPortalSSID().c_str(), g_system.portalApPassword.c_str());
    });
}

void WifiManager::_updateStatusFromWiFi() {
    g_system.isWifiConnected = (WiFi.status() == WL_CONNECTED);
    if (g_system.isWifiConnected) {
        if (g_system.accessPointActive && !g_system.portalActive) {
            _stopFallbackPortal();
        }
        g_system.wifiSsid = WiFi.SSID();
        g_system.wifiIp = WiFi.localIP().toString();
        g_system.wifiRssi = WiFi.RSSI();
        _connected = true;
        g_system.lastWifiError = "";
    } else {
        g_system.wifiSsid = "";
        g_system.wifiIp = "";
        g_system.wifiRssi = WiFi.RSSI();
        _connected = false;
    }
}

void WifiManager::_setPortalState(bool portalActive, bool apActive) {
    g_system.portalActive = portalActive;
    g_system.accessPointActive = apActive;
}

bool WifiManager::_waitForConnection(unsigned long timeoutMs) {
    const unsigned long startedAt = millis();
    while ((millis() - startedAt) < timeoutMs) {
        if (WiFi.status() == WL_CONNECTED) {
            return true;
        }
        delay(100);
        yield();
    }
    return WiFi.status() == WL_CONNECTED;
}

void WifiManager::_startFallbackPortal() {
    if (g_system.accessPointActive || _portalRunning) {
        return;
    }

    WiFi.mode(WIFI_AP_STA);
    const bool started = WiFi.softAP(g_system.portalApSsid.c_str(), g_system.portalApPassword.c_str());
    if (started) {
        _setPortalState(false, true);
        stateSet(STATE_WIFI_SETUP);
        g_lcd.showQrCode(g_system.portalApSsid.c_str(), g_system.portalApPassword.c_str());
        Serial.print(F("[WiFi] Fallback AP started: "));
        Serial.println(g_system.portalApSsid);
    }
}

void WifiManager::_stopFallbackPortal() {
    if (!g_system.accessPointActive) {
        return;
    }

    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    _setPortalState(false, false);
}
