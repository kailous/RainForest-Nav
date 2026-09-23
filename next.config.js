const path = require('path');

module.exports = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.vercel-storage.com',
      },
      {
        protocol: 'https',
        hostname: '**.blob.vercel-storage.com',
      },
    ],
  },
  webpack: (config) => {
    config.resolve.alias['@'] = path.resolve(__dirname);
    return config;
  },
  // Next does not route dot-directories, so OAuth discovery documents are served
  // through API routes that can resolve the requesting origin at runtime.
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/wellknown/oauth-protected-resource',
      },
      {
        // RFC 9728 allows the resource path to be appended to the well-known URI.
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/wellknown/oauth-protected-resource',
      },
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/wellknown/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/wellknown/oauth-authorization-server',
      },
      // Public OAuth endpoints live under /oauth/* as advertised in the
      // authorization server metadata, while the handlers sit in pages/api.
      { source: '/oauth/authorize', destination: '/api/oauth/authorize' },
      { source: '/oauth/register', destination: '/api/oauth/register' },
      { source: '/oauth/token', destination: '/api/oauth/token' },
    ];
  },
};

// 扩展构建配置
const extensionConfig = {
  ...module.exports,
  output: 'export',
  images: {
    ...module.exports.images,
    unoptimized: true,
  },
  assetPrefix: './',
};

module.exports.withExtension = () => extensionConfig;
