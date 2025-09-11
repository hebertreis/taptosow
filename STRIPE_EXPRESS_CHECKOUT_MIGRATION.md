# Stripe Express Checkout Migration Guide

## Overview
This document outlines the migration from Stripe's legacy Payment Request Button to the modern Express Checkout Element. This migration resolves the warning: "You're using a legacy wallets integration."

## What Changed

### 1. Legacy Implementation (Before)
- Used `paymentRequest` API with `paymentRequestButton` element
- Required manual availability checking with `canMakePayment()`
- Used event-based approach with `paymentmethod` events

### 2. Modern Implementation (After)
- Uses `expressCheckout` element
- Automatic availability detection through `ready` event
- Simplified payment confirmation with `confirm` event
- Better integration with Apple Pay, Google Pay, and other wallets

## Updated Files

### `/src/hooks/usePaymentRequest.ts`
**Key Changes:**
- Replaced `paymentRequest` with `expressCheckout` element
- Updated payment flow to use `confirm` event instead of `paymentmethod`
- Simplified availability detection
- Improved error handling

**New API:**
```typescript
const expressElement = elements.create('expressCheckout', {
  mode: 'payment',
  amount: Math.round(amount * 100),
  currency: currency,
  paymentMethodTypes: ['card', 'apple_pay', 'google_pay'],
  wallets: {
    applePay: 'auto',
    googlePay: 'auto',
    link: 'never', // Maintains current behavior
  },
});
```

### `/src/components/PaymentSelector.tsx`
**Key Changes:**
- Updated element ID from `wallet-payment-button` to `express-checkout-element`
- Adjusted minimum height for better Express Checkout rendering
- Updated comments to reflect new Express Checkout usage

### `/src/types/payment.ts`
**Key Changes:**
- Added `'digital-wallet'` to `PaymentMethod` type for better TypeScript support

## Benefits of Migration

1. **Future-Proof**: Express Checkout is Stripe's modern wallet integration
2. **Better Performance**: Improved loading and rendering
3. **Enhanced Conversion**: Better user experience for wallet payments
4. **Automatic Updates**: Receives new wallet features automatically
5. **Warning Resolution**: Eliminates the legacy API warning

## Testing Checklist

- [ ] Apple Pay button appears when available (Safari/iOS)
- [ ] Google Pay button appears when available (Chrome/Android)
- [ ] Payment flow completes successfully
- [ ] No console warnings about legacy APIs
- [ ] Fallback to other payment methods works correctly
- [ ] Currency changes update the element correctly

## Browser Console Verification

After migration, you should no longer see:
```
[Stripe.js] You're using a legacy wallets integration.
```

Instead, you should see the Express Checkout element loading without warnings.

## Rollback Plan

If issues arise, the previous implementation can be restored by:
1. Reverting changes to `usePaymentRequest.ts`
2. Reverting changes to `PaymentSelector.tsx`
3. Updating the PaymentMethod type back to exclude 'digital-wallet'

## Additional Resources

- [Stripe Express Checkout Documentation](https://docs.stripe.com/elements/express-checkout-element)
- [Migration Guide](https://docs.stripe.com/elements/express-checkout-element/migration)
- [Comparison with Legacy API](https://docs.stripe.com/elements/express-checkout-element/comparison)