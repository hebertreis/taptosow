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
    
    // Generate device ID from MAC address
    uint8_t mac[6];
    WiFi.macAddress(mac);
    g_system.deviceId = String(MQTT_CLIENT_PREFIX) + "_" +
                        String(mac[4], HEX) +
                        String(mac[5], HEX);
    g_system.mqttTopicBase = "onetapgo/" + g_system.deviceId;
    
    Serial.print(F("[WiFi] Device ID: "));
    Serial.println(g_system.deviceId);
    
    // Configure WiFi Manager
    WiFiManager wifiManager;
    
    // Set timeouts
    wifiManager.setConfigPortalTimeout(180);
    wifiManager.setConnectTimeout(60);
    
    // Custom AP SSID
    String apSSID = "OneTapGo_" + g_system.deviceId.substring(g_system.deviceId.length() - 6);
    const char* apPassword = "onetapgo123";
    
    // Custom text
    WiFiManagerParameter customText("<p style='text-align:center;font-weight:bold;'>OneTapGo NFC Writer</p>");
    wifiManager.addParameter(&customText);
    
    // AP callback
    wifiManager.setAPCallback([](WiFiManager* wm) {
        Serial.println(F("[WiFi] Configuration portal started"));
        g_lcd.showQrCode(wm->getConfigPortalSSID().c_str(), "onetapgo123");
    });
    
    // Connect or start portal
    if (!wifiManager.autoConnect(apSSID.c_str(), apPassword)) {
        Serial.println(F("[WiFi] Failed to connect, restarting..."));
        g_lcd.showMessage("WiFi Error", "Restarting...", 3000);
        delay(3000);
        ESP.restart();
        return false;
    }
    
    _connected = true;
    g_system.isWifiConnected = true;
    
    Serial.println(F("[WiFi] Connected successfully"));
    Serial.print(F("[WiFi] IP address: "));
    Serial.println(WiFi.localIP());
    
    g_lcd.showMessage("WiFi OK", WiFi.localIP().toString().c_str(), 1000);
    return true;
}

bool WifiManager::isConnected() {
    if (WiFi.status() != WL_CONNECTED) {
        _connected = false;
        g_system.isWifiConnected = false;
        return false;
    }
    return _connected;
}

String WifiManager::getIPAddress() {
    return WiFi.localIP().toString();
}

int WifiManager::getRSSI() {
    return WiFi.RSSI();
}

String WifiManager::getSSID() {
    return WiFi.SSID();
}
