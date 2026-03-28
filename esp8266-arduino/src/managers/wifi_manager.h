/**
 * @file wifi_manager.h
 * @brief WiFi manager for OneTapGo
 */

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <ESP8266WiFi.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include "config/wifi_config.h"
#include "core/system_state.h"

// ============================================================================
// WiFi Manager Class
// ============================================================================
class WifiManager {
public:
    /**
     * Initialize WiFi with WiFiManager
     * @return true if connected
     */
    bool begin();

    /**
     * Service runtime connection state
     */
    void loop();
    
    /**
     * Check WiFi connection
     * @return true if connected
     */
    bool isConnected();
    
    /**
     * Get IP address
     */
    String getIPAddress();
    
    /**
     * Get RSSI
     */
    int getRSSI();
    
    /**
     * Get SSID
     */
    String getSSID();

    /**
     * Get current config portal SSID
     */
    String getPortalSSID();

    bool scanNetworks(JsonArray networks, bool& truncated);
    bool applyCredentials(const String& ssid,
                          const String& password,
                          unsigned long timeoutMs,
                          bool portalOnFail,
                          String& errorMessage);
    bool resetCredentials(bool startPortal, String& errorMessage);
    bool openConfigPortal(unsigned long timeoutSec, String& errorMessage);

private:
    WiFiManager _wifiManager;
    bool _connected = false;
    bool _portalRunning = false;
    unsigned long _lastReconnectAttempt = 0;

    void _configureManager(unsigned long timeoutSec);
    void _updateStatusFromWiFi();
    void _setPortalState(bool portalActive, bool apActive);
    bool _waitForConnection(unsigned long timeoutMs);
    void _startFallbackPortal();
    void _stopFallbackPortal();
};

// ============================================================================
// Global WiFi Manager Instance
// ============================================================================
extern WifiManager g_wifiManager;

#endif // WIFI_MANAGER_H
