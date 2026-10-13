/** @type {import('next').NextConfig} */
const nextConfig = {
  // Otherwise Next walks up to the parent's package-lock.json and infers the
  // wrong workspace root, since this app is nested inside the Fuel backend
  // repo rather than being a sibling of it.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
