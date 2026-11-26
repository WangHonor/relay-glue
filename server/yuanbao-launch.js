'use strict';
/**
 * yuanbao-launch.js —— 起一个专用 profile 的 Edge 并打开元宝，供你扫码登录一次（之后免登复用）。
 * 用法： node server/yuanbao-launch.js            （默认调试端口 9333）
 * 登录后再跑：node server/yuanbao-calibrate.js     来把输入框/发送键/答案节点的 CSS 选择器打出来，
 * 用 RELAY_YB_INPUT_SEL / RELAY_YB_SEND_SEL / RELAY_YB_ANSWER_SEL 固化，再走 chain。
 */
const { launch } = require('./yuanbao');
const port = parseInt(process.env.RELAY_CDP_PORT || '9333', 10);
const r = launch(port);
console.log('已启动 Edge。pid=', r.pid, '\n调试端口=', port, '\nprofile=', r.profile);
console.log('→ 请在弹出的 Edge 里登录 yuanbao.tencent.com（扫码一次即可）。登录态存于该 profile。');
console.log('→ 然后跑：node server/yuanbao-calibrate.js 校准选择器。');
