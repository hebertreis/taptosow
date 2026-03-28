/**
 * @file button_manager.cpp
 * @brief Flash button gesture manager implementation
 */

#include "managers/button_manager.h"

#include "config/hardware_config.h"

namespace {
constexpr unsigned long kDebounceMs = 40UL;
}

ButtonManager g_buttonManager;

void ButtonManager::begin() {
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    _initialized = true;
    _lastRawReading = digitalRead(BUTTON_PIN);
    _stableState = _lastRawReading;
    _longPressReported = false;
    _clickCount = 0;
    _lastDebounceAt = millis();
    _pressedAt = 0;
    _sequenceDeadline = 0;
}

ButtonEventType ButtonManager::loop() {
    if (!_initialized) {
        return BUTTON_EVENT_NONE;
    }

    const unsigned long now = millis();
    const int rawReading = digitalRead(BUTTON_PIN);

    if (rawReading != _lastRawReading) {
        _lastRawReading = rawReading;
        _lastDebounceAt = now;
    }

    if ((now - _lastDebounceAt) >= kDebounceMs && rawReading != _stableState) {
        _stableState = rawReading;

        if (_stableState == LOW) {
            _pressedAt = now;
            _longPressReported = false;
            return BUTTON_EVENT_NONE;
        }

        if (!_longPressReported) {
            ++_clickCount;
            _sequenceDeadline = now + BUTTON_MULTI_CLICK_WINDOW_MS;
        }
        _pressedAt = 0;
    }

    if (_stableState == LOW && !_longPressReported && _pressedAt != 0 &&
        (now - _pressedAt) >= BUTTON_LONG_PRESS_MS) {
        _longPressReported = true;
        _clickCount = 0;
        _sequenceDeadline = 0;
        return BUTTON_EVENT_LONG_PRESS;
    }

    if (_clickCount > 0 && _sequenceDeadline != 0 && (long)(now - _sequenceDeadline) >= 0) {
        const uint8_t resolvedClicks = _clickCount;
        _clickCount = 0;
        _sequenceDeadline = 0;

        if (resolvedClicks == 1) {
            return BUTTON_EVENT_SINGLE;
        }
        if (resolvedClicks == 2) {
            return BUTTON_EVENT_DOUBLE;
        }
        return BUTTON_EVENT_TRIPLE;
    }

    return BUTTON_EVENT_NONE;
}
