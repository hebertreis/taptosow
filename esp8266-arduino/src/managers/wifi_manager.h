/**
 * @file wifi_manager.h
 * @brief WiFi manager for OneTapGo
 */

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <ESP8266WiFi.h>
#include <WiFiManager.h>
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

private:
    bool _connected = false;
    unsigned long _lastReconnectAttempt = 0;

    void _updateStatusFromWiFi();
    void _startFallbackPortal();
    void _stopFallbackPortal();
};

// ============================================================================
// Global WiFi Manager Instance
// ============================================================================
extern WifiManager g_wifiManager;

#endif // WIFI_MANAGER_H
