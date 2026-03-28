/**
 * @file nfc_config.h
 * @brief NFC configuration for OneTapGo ESP8266
 */

#ifndef NFC_CONFIG_H
#define NFC_CONFIG_H

// ============================================================================
// NFC Timing
// ============================================================================
#define NFC_INIT_DELAY_MS           1000UL
#define NFC_TAG_DETECT_DELAY_MS     10UL
#define NFC_WRITE_TIMEOUT_MS        5000UL
#define NFC_READ_TIMEOUT_MS         3000UL

// ============================================================================
// NFC Wait Timeout (when waiting for tag)
// ============================================================================
// Time to wait for a tag to appear before timeout
#define NFC_WAIT_TIMEOUT_MS         30000UL
#define NFC_WARNING_BEFORE_MS       5000UL

// ============================================================================
// NDEF Configuration
// ============================================================================
#define NDEF_MAX_RECORDS            4
#define NDEF_MAX_PAYLOAD_LEN        256
#define NDEF_URI_MAX_LENGTH         240

// NFC job defaults
#define NFC_DEFAULT_COMMAND_TIMEOUT_SEC 30UL
#define NFC_MIN_COMMAND_TIMEOUT_SEC     5UL
#define NFC_MAX_COMMAND_TIMEOUT_SEC     180UL
#define NFC_TAG_REMOVAL_TIMEOUT_MS      10000UL

// ============================================================================
// RC522 Antenna Gain
// ============================================================================
// Use maximum gain for better range
#define RC522_ANTENNA_GAIN  RxGain_max

// ============================================================================
// RC522 RF Configuration
// ============================================================================
// RxGain_48dB = maximum receiver gain (0x08 << 4)
// Higher values = better range but more noise
#define RC522_RF_CONFIG 0x08

// Modulation width for ISO14443A communication
// Default is usually 25 (0x19), trying 26 for better compatibility
#define RC522_MOD_WIDTH 26

// ============================================================================
// RC522 Detection Strategy
// ============================================================================
// Try WakeupA first (more power, better for difficult tags)
#define NFC_USE_WAKEUP_FIRST 1

#endif // NFC_CONFIG_H
