/**
 * @file mqtt_config.h
 * @brief MQTT configuration for OneTapGo ESP8266
 */

#ifndef MQTT_CONFIG_H
#define MQTT_CONFIG_H

// ============================================================================
// MQTT Broker Configuration
// ============================================================================
#define MQTT_HOST               "m191dfff.ala.us-east-1.emqxsl.com"
#define MQTT_PORT               8883
#define MQTT_USERNAME           "onetapgo"
#define MQTT_PASSWORD           "onetapgo"
#define MQTT_USE_TLS            true
#define MQTT_CLIENT_PREFIX      "onetapgo_device"

// Keep the MQTT frame compact on ESP8266. Status/heartbeat are small and
// results only carry a single URI payload plus card summary.
#define MQTT_BUFFER_SIZE_BYTES   1024

// ============================================================================
// MQTT Timing
// ============================================================================
#define MQTT_RECONNECT_DELAY_MS   5000UL
#define MQTT_KEEPALIVE_SEC        60
#define MQTT_SOCKET_TIMEOUT_SEC   30
#define HEARTBEAT_INTERVAL_MS     30000UL

// ============================================================================
// MQTT Topics (base: onetapgo/{deviceId})
// ============================================================================
// - /status     - Retained device snapshot
// - /heartbeat  - Periodic live status
// - /command    - Commands from the web interface
// - /result     - NFC job results and tag reads
// - /debug      - Debug and compatibility flags

// ============================================================================
// MQTT Command Types
// ============================================================================
// - write:          { "type": "write", "requestId": "...", "url": "https://...", "timeoutSec": 30, "lock": false }
// - write_tag:      compatibility alias for write
// - read:           { "type": "read", "requestId": "...", "timeoutSec": 20 }
// - read_tag:       compatibility alias for read
// - set_debug:      { "type": "set_debug", "enabled": true/false }
// - set_read_mode:  legacy UI compatibility flag only
// - status:         { "type": "status" }
// - restart:        { "type": "restart" }

// ============================================================================
// Reconnection
// ============================================================================
#define MAX_RECONNECT_ATTEMPTS  10

#endif // MQTT_CONFIG_H
