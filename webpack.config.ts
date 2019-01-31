import * as webpack from 'webpack';
import * as path from 'path';

const config: webpack.Configuration = {
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js"],
  },
  entry: [
    './src/server.ts',
  ],
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name]-bundle.js',
    chunkFilename: '[name]-[chunkhash].js',
  },
  module: {
    rules: [
      {
        test: /(\.js|\.ts)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
        ],
      },
    ],
  },
  target: 'node',
};

export default config;
