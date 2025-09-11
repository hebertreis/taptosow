# Payment Request Button Fix

## Issue Fixed
**Error**: `Uncaught IntegrationError: Can only create one Element of type paymentRequestButton`

## Root Cause
The error occurred because the `updatePaymentRequest()` function was creating new payment request buttons every time the amount or currency changed, without properly managing the existing button lifecycle.

## Solution Applied

### 1. **Button Lifecycle Management**
- Added `isPaymentRequestMounted` flag to track button state
- Only create new payment request button once, then reuse it
- Use `paymentRequest.update()` for amount changes instead of recreating

### 2. **Improved Event Handling**
- **Amount changes**: Only update the payment request amount, don't recreate button
- **Currency changes**: Reset and recreate payment request system (required for currency/country changes)
- **Preset buttons**: Update amount without recreating payment request

### 3. **Memory Management**
- Properly clear existing buttons when currency changes
- Add event listener tracking to prevent duplicate listeners
- Clean DOM container before recreating elements

## Key Changes Made

```javascript
// Before (problematic)
function updatePaymentRequest() {
    // Always created new button
    prButton = elements.create('paymentRequestButton', {...});
}

// After (fixed)
function updatePaymentRequest() {
    // Only update existing payment request if available
    if (paymentRequest) {
        paymentRequest.update({...});
        return;
    }
    // Create new only if none exists
    if (!prButton) {
        prButton = elements.create('paymentRequestButton', {...});
    }
}
```

## Benefits
- ✅ No more Stripe integration errors
- ✅ Smooth amount updates without button recreation
- ✅ Proper currency switching with clean recreation
- ✅ Better performance and memory usage
- ✅ Maintains all payment functionality (Apple Pay, Google Pay, Cards)

## Testing
The fix has been deployed to: https://taptosow-staging.web.app

Test scenarios:
1. ✅ Change amount using preset buttons
2. ✅ Change amount using input field
3. ✅ Change currency selection
4. ✅ All payment methods still work
5. ✅ No console errors