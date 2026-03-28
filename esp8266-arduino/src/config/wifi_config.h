/**
 * @file wifi_config.h
 * @brief WiFi configuration for OneTapGo ESP8266
 */

#ifndef WIFI_CONFIG_H
#define WIFI_CONFIG_H

// ============================================================================
// WiFi Portal Defaults
// ============================================================================
#define WIFI_AP_PREFIX                "OneTapGo_"
#define WIFI_AP_PASSWORD              "onetapgo123"
#define WIFI_CONFIG_PORTAL_TIMEOUT_SEC 180
#define WIFI_CONNECT_TIMEOUT_SEC      60
#define WIFI_COMMAND_CONNECT_TIMEOUT_SEC 30
#define WIFI_SCAN_RESULT_LIMIT        6

// ============================================================================
// WiFi Runtime
// ============================================================================
#define WIFI_RECONNECT_INTERVAL_MS    10000UL

#endif // WIFI_CONFIG_H
