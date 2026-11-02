// pm2 配置（如果运维不用 systemd，而用 pm2 守护）
// 用法：
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'campus-vote',
      script: 'server.js',
      cwd: '/var/www/campus-vote',
      node_args: '--experimental-sqlite',
      instances: 1,               // 必须 1 个实例：SQLite + 内存限流都是单进程假设
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      max_memory_restart: '256M',
      kill_timeout: 15000,        // 给 SIGTERM 留出关闭 SQLite 的时间
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
        // 其余变量建议放 /etc/campus-vote.env，用下面的 env_file 加载
      },
      // pm2 5.2+ 支持
      env_file: '/etc/campus-vote.env',
      out_file: '/var/log/campus-vote/out.log',
      error_file: '/var/log/campus-vote/error.log',
      time: true,
    },
  ],
};
