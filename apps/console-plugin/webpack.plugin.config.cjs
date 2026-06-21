const path = require("node:path");
const { ConsoleRemotePlugin } = require("@openshift-console/dynamic-plugin-sdk-webpack");

module.exports = {
  mode: "production",
  context: __dirname,
  entry: {},
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    chunkFilename: "[name]-chunk.js",
    publicPath: "auto",
    clean: false
  },
  resolve: {
    extensions: [".tsx", ".ts", ".jsx", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: "ts-loader",
          options: {
            configFile: path.resolve(__dirname, "tsconfig.plugin.json"),
            transpileOnly: true
          }
        }
      }
    ]
  },
  plugins: [
    new ConsoleRemotePlugin({
      validateSharedModules: false
    })
  ],
  optimization: {
    chunkIds: "named"
  }
};

