const nextConfig = {
  reactStrictMode: false,
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
    NEXT_PUBLIC_CARD_CONNECTION_PROVIDER: process.env.NEXT_PUBLIC_CARD_CONNECTION_PROVIDER || process.env.VITE_CARD_CONNECTION_PROVIDER || 'mock',
  },
};

export default nextConfig;
