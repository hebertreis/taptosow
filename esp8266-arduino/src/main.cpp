/**
 * @file main.cpp
 * @brief OneTapGo ESP8266 NFC Writer with MQTT Integration
 * 
 * Hardware: NodeMCU LoLin V3 (HW 364-A) with RC522 NFC Reader and LCD Display
 * 
 * Features:
 * - WiFi Manager for hotspot configuration
 * - MQTT over TLS for secure communication
 * - LCD display for operator feedback
 * - NFC/RFID tag reading and writing
 * - SPI/I2C pin sharing coordination (GPIO 12, 14)
 * 
 * Architecture:
 * - core/system_state.*    : Global state and coordination
 * - core/coordinator.*     : Main orchestration logic
 * - managers/nfc_manager.* : NFC/RC522 operations
 * - managers/lcd_manager.* : LCD/SSD1306 display
 * - managers/mqtt_manager.*: MQTT client and commands
 * - managers/wifi_manager.*: WiFi connectivity
 * - config headers         : Configuration headers
 * 
 * @version 5.0.0
 * @author OneTapGo by CRE8 Tecnologia
 */

#include <ESP8266WiFi.h>
#include <SPI.h>
#include <Wire.h>

// Configuration
#include "config/hardware_config.h"
#include "config/mqtt_config.h"
#include "config/nfc_config.h"

// Core modules
#include "core/system_state.h"
#include "core/coordinator.h"

// Managers
#include "managers/lcd_manager.h"
#include "managers/nfc_manager.h"
#include "managers/mqtt_manager.h"
#include "managers/wifi_manager.h"

// ============================================================================
// Arduino Setup & Loop
// ============================================================================

void setup() {
    // Initialize serial first
    Serial.begin(115200);
    delay(1000);
    
    // Run coordinator initialization
    Coordinator::getInstance().begin();
}

void loop() {
    // Run coordinator main loop
    Coordinator::getInstance().loop();
}
