const path = require("node:path");

module.exports = {
  mode: "production",
  context: __dirname,
  entry: {
    "cas-local-preview": "./src/local-preview.tsx"
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    publicPath: "./"
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
  }
};
