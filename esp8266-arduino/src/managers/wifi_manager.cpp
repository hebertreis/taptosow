/**
 * @file wifi_manager.cpp
 * @brief WiFi manager implementation
 */

#include "managers/wifi_manager.h"
#include "managers/lcd_manager.h"
#include "core/system_state.h"

WifiManager g_wifiManager;

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
    
    // Configure WiFi Manager
    WiFiManager wifiManager;
    
    // Set timeouts
    wifiManager.setConfigPortalTimeout(WIFI_CONFIG_PORTAL_TIMEOUT_SEC);
    wifiManager.setConnectTimeout(WIFI_CONNECT_TIMEOUT_SEC);
    wifiManager.setDebugOutput(false);
    
    // Custom AP SSID
    String apSSID = g_system.portalApSsid;
    const char* apPassword = g_system.portalApPassword.c_str();
    
    // Custom text
    WiFiManagerParameter customText("<p style='text-align:center;font-weight:bold;'>OneTapGo NFC Writer</p>");
    wifiManager.addParameter(&customText);
    
    // AP callback
    wifiManager.setAPCallback([](WiFiManager* wm) {
        Serial.println(F("[WiFi] Configuration portal started"));
        g_system.portalActive = true;
        stateSet(STATE_WIFI_SETUP);
        g_lcd.showQrCode(wm->getConfigPortalSSID().c_str(), g_system.portalApPassword.c_str());
    });
    
    // Connect or start portal
    if (!wifiManager.autoConnect(apSSID.c_str(), apPassword)) {
        Serial.println(F("[WiFi] Failed to connect, restarting..."));
        g_system.portalActive = true;
        g_system.isWifiConnected = false;
        g_lcd.showMessage("WiFi Error", "Restarting...", 3000);
        ESP.restart();
        return false;
    }

    _connected = true;
    g_system.portalActive = false;
    _updateStatusFromWiFi();
    stateSet(STATE_IDLE);

    Serial.println(F("[WiFi] Connected successfully"));
    Serial.print(F("[WiFi] IP address: "));
    Serial.println(g_system.wifiIp);

    return true;
}

void WifiManager::loop() {
    if (WiFi.status() == WL_CONNECTED) {
        if (g_system.portalActive) {
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

void WifiManager::_updateStatusFromWiFi() {
    g_system.isWifiConnected = (WiFi.status() == WL_CONNECTED);
    if (g_system.isWifiConnected) {
        if (g_system.portalActive) {
            _stopFallbackPortal();
        }
        g_system.wifiSsid = WiFi.SSID();
        g_system.wifiIp = WiFi.localIP().toString();
        g_system.wifiRssi = WiFi.RSSI();
        _connected = true;
    } else {
        g_system.wifiSsid = "";
        g_system.wifiIp = "";
        g_system.wifiRssi = WiFi.RSSI();
        _connected = false;
    }
}

void WifiManager::_startFallbackPortal() {
    if (g_system.portalActive) {
        return;
    }

    WiFi.mode(WIFI_AP_STA);
    const bool started = WiFi.softAP(g_system.portalApSsid.c_str(), g_system.portalApPassword.c_str());
    if (started) {
        g_system.portalActive = true;
        stateSet(STATE_WIFI_SETUP);
        g_lcd.showQrCode(g_system.portalApSsid.c_str(), g_system.portalApPassword.c_str());
        Serial.print(F("[WiFi] Fallback AP started: "));
        Serial.println(g_system.portalApSsid);
    }
}

void WifiManager::_stopFallbackPortal() {
    if (!g_system.portalActive) {
        return;
    }

    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    g_system.portalActive = false;
}
