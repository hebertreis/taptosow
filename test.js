amount = 567.77;
currency = 'usd';
const normalizedAmount = Math.round(amount * 100) / 100;
      const payload = { amount: normalizedAmount, currency };
      console.log(payload);