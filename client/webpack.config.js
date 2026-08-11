import path from "node:path";
import { fileURLToPath } from "node:url";
import CopyWebpackPlugin from "copy-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";
import TerserPlugin from "terser-webpack-plugin";
import webpack from "webpack";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default (_env, argv) => {
  const production = argv.mode === "production";
  const apiTarget =
    process.env.API_PROXY_TARGET || "http://localhost:5100";
  const downloadBase = process.env.API_DOWNLOAD_BASE || "";

  return {
    entry: path.resolve(directory, "src/main.jsx"),
    output: {
      path: path.resolve(directory, "dist"),
      filename: "assets/[name].[contenthash:8].js",
      chunkFilename: "assets/[name].[contenthash:8].js",
      clean: true,
      publicPath: "/",
    },
    devtool: production ? false : "source-map",
    resolve: {
      extensions: [".js", ".jsx"],
    },
    module: {
      rules: [
        {
          test: /\.jsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: {
              presets: [
                ["@babel/preset-env", { targets: "defaults" }],
                ["@babel/preset-react", { runtime: "automatic" }],
              ],
            },
          },
        },
        {
          test: /\.css$/i,
          use: ["style-loader", "css-loader"],
        },
        {
          test: /\.(png|jpe?g|gif|svg|webp|ico)$/i,
          type: "asset/resource",
          generator: { filename: "assets/[name].[contenthash:8][ext]" },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({ template: path.resolve(directory, "index.html") }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.resolve(directory, "public"),
            to: ".",
            noErrorOnMissing: true,
          },
        ],
      }),
      new webpack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify(
          production ? "production" : "development",
        ),
        "process.env.API_DOWNLOAD_BASE": JSON.stringify(downloadBase),
      }),
    ],
    optimization: {
      minimize: production,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: { drop_console: production, passes: 2 },
            format: { comments: false },
          },
          extractComments: false,
        }),
      ],
      splitChunks: {
        cacheGroups: {
          react: {
            test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            name: "react",
            chunks: "all",
          },
        },
      },
    },
    devServer: {
      host: "127.0.0.1",
      port: 5173,
      historyApiFallback: true,
      static: { directory: path.resolve(directory, "public") },
      proxy: [
        {
          context: ["/api"],
          target: apiTarget,
          changeOrigin: true,
        },
      ],
      headers: production
        ? { "Cache-Control": "public, max-age=3600" }
        : undefined,
    },
    performance: { maxAssetSize: 500000, maxEntrypointSize: 500000 },
  };
};
