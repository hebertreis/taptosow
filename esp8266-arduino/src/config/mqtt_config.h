/**
 * @file mqtt_config.h
 * @brief MQTT configuration for OneTapGo ESP8266
 */

#ifndef MQTT_CONFIG_H
#define MQTT_CONFIG_H

// ============================================================================
// MQTT Broker Configuration
// ============================================================================
#define MQTT_HOST             "m191dfff.ala.us-east-1.emqxsl.com"
#define MQTT_PORT             8883
#define MQTT_USERNAME         "onetapgo"
#define MQTT_PASSWORD         "onetapgo"
#define MQTT_USE_TLS          true
#define MQTT_CLIENT_PREFIX    "onetapgo_device"

// ============================================================================
// MQTT Timing
// ============================================================================
#define MQTT_RECONNECT_DELAY_MS   5000   // Delay between reconnect attempts
#define MQTT_KEEPALIVE_SEC        60     // MQTT keepalive interval
#define MQTT_SOCKET_TIMEOUT_SEC   30     // Socket timeout
#define HEARTBEAT_INTERVAL_MS     30000  // Heartbeat publish interval

// ============================================================================
// MQTT Topics (base: onetapgo/{deviceId})
// ============================================================================
// - /status     - Device status updates
// - /heartbeat  - Heartbeat messages
// - /command    - Commands from admin
// - /result     - Write results and tag data
// - /debug      - Debug and mode status

// ============================================================================
// MQTT Command Types
// ============================================================================
// - write_tag:      { "type": "write_tag", "tenantId": "xxx", "sectorId": "yyy", "url": "..." }
// - set_debug:      { "type": "set_debug", "enabled": true/false }
// - set_read_mode:  { "type": "set_read_mode", "enabled": true/false }
// - read_tag:       { "type": "read_tag" }
// - status:         { "type": "status" }
// - restart:        { "type": "restart" }

// ============================================================================
// Reconnection
// ============================================================================
#define MAX_RECONNECT_ATTEMPTS  10

#endif // MQTT_CONFIG_H
