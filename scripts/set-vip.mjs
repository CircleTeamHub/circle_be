function usage() {
  return 'Direct VIP writes are retired. Use the authenticated admin membership grant API.';
}

console.error(usage());
process.exitCode = 2;
