/**
 * @file hardware_config.h
 * @brief Hardware pin configuration for OneTapGo ESP8266
 * 
 * Hardware: NodeMCU LoLin V3 (HW 364-A)
 * - RC522 NFC Reader (SPI)
 * - SSD1306 OLED Display (I2C on shared pins)
 * 
 * IMPORTANT: SPI (RC522) and I2C (OLED) share GPIO 12 and 14
 * Coordination is required to avoid conflicts!
 */

#ifndef HARDWARE_CONFIG_H
#define HARDWARE_CONFIG_H

// ============================================================================
// RC522 NFC Reader - Hardware SPI
// ============================================================================
// SPI pins are fixed on ESP8266:
// - SCK:  GPIO 14 (D5)
// - MISO: GPIO 12 (D6)
// - MOSI: GPIO 13 (D7)
// - SS:   Configurable (using GPIO 4 / D2)
// - RST:  Configurable (using GPIO 5 / D1)

#define RC522_SS_PIN   4   // D2 (GPIO 4) - Chip Select
#define RC522_RST_PIN  5   // D1 (GPIO 5) - Reset

// ============================================================================
// SSD1306 OLED Display - Software I2C (shared pins with SPI)
// ============================================================================
// I2C shares pins with SPI - requires coordination:
// - SDA: GPIO 14 (D5) - shares with SPI SCK
// - SCL: GPIO 12 (D6) - shares with SPI MISO

// LCD is currently not part of the critical path. Keep it disabled until the
// shared-bus wiring is revisited.
#define LCD_ENABLED    1

#define OLED_SDA_PIN   14  // D5 (GPIO 14) - shares with SPI SCK
#define OLED_SCL_PIN   12  // D6 (GPIO 12) - shares with SPI MISO
#define OLED_RESET_PIN -1  // Not connected (or use GPIO 16 / D0)
#define OLED_ADDRESS   0x3C
#define OLED_WIDTH     128
#define OLED_HEIGHT    64

// ============================================================================
// Button (optional manual trigger)
// ============================================================================
#define BUTTON_PIN     0   // D3 (GPIO 0) - Optional button
#define BUTTON_MULTI_CLICK_WINDOW_MS 700UL
#define BUTTON_LONG_PRESS_MS        5000UL
#define LCD_OVERLAY_DURATION_MS     6000UL
#define LCD_MESSAGE_DURATION_MS     1800UL

// ============================================================================
// Built-in status LED
// ============================================================================
#ifndef LED_BUILTIN
#define LED_BUILTIN    2   // ESP8266 onboard LED (active low)
#endif

#define STATUS_LED_PIN         LED_BUILTIN
#define STATUS_LED_ACTIVE      LOW
#define STATUS_LED_INACTIVE    HIGH
#define STATUS_LED_BLINK_MS    80UL

// ============================================================================
// Timing Configuration
// ============================================================================
#define NFC_POLL_INTERVAL_MS    200   // NFC polling interval (200ms for better reliability)
#define LCD_UPDATE_INTERVAL_MS  500   // LCD update interval when idle
#define LCD_HOLD_INTERVAL_MS    2000  // LCD hold time for messages
#define NFC_ACTIVITY_TIMEOUT_MS 5000  // NFC operation timeout

// ============================================================================
// SPI/I2C Coordination
// ============================================================================
// Time to wait after I2C transaction before SPI can be used
#define I2C_TO_SPI_DELAY_US     50    // Microseconds
#define SPI_STABILIZE_DELAY_MS  5     // Milliseconds for SPI to stabilize

#endif // HARDWARE_CONFIG_H
