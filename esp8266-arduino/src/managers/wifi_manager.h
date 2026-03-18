/**
 * @file wifi_manager.h
 * @brief WiFi manager for OneTapGo
 */

#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <ESP8266WiFi.h>
#include <WiFiManager.h>

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
    
private:
    bool _connected = false;
};

// ============================================================================
// Global WiFi Manager Instance
// ============================================================================
extern WifiManager g_wifiManager;

#endif // WIFI_MANAGER_H
