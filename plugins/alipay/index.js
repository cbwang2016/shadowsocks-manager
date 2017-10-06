const log4js = require('log4js');
const logger = log4js.getLogger('alipay');
const cron = appRequire('init/cron');
const config = appRequire('services/config').all();
const crypto = require('crypto');
// const alipayf2f = require('alipay-ftof');
var jsjConfig;
if (config.plugins.alipay && config.plugins.alipay.use) {
  jsjConfig = {
    apiid: config.plugins.alipay.apiid,
    apikey: config.plugins.alipay.apikey,
    jsjGatewayUrl: config.plugins.alipay.jsjGatewayUrl,
  };
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const knex = appRequire('init/knex').knex;
const account = appRequire('plugins/account/index');
const moment = require('moment');
const push = appRequire('plugins/webgui/server/push');

const createOrder = async (user, account, amount, orderType = 3) => {
  const oldOrder = await knex('alipay').select().where({
    user,
    account: account ? account : null,
    amount: amount.toFixed(2) + '',
    orderType,
  }).where('expireTime', '>', Date.now() + 15 * 60 * 1000).where({
    status: 'CREATE',
  }).then(success => {
    return success[0];
  });
  if (oldOrder) {
    return {
      orderId: oldOrder.orderId,
      qrCode: oldOrder.qrcode,
    };
  }
  // const orderId = moment().format('YYYYMMDDHHmmss') + Math.random().toString().substr(2, 6);
  const orderId = '21' + jsjConfig.apiid.toString() + moment().format('YYYYMMDDHHmmss') + Math.random().toString().substr(2, 6);
  const time = 60;
  const orderSetting = await knex('webguiSetting').select().where({
    key: 'payment',
  }).then(success => {
    if (!success.length) {
      return Promise.reject('settings not found');
    }
    success[0].value = JSON.parse(success[0].value);
    return success[0].value;
  }).then(success => {
    if (orderType === 5) { return success.hour; }
    else if (orderType === 4) { return success.day; }
    else if (orderType === 2) { return success.week; }
    else if (orderType === 3) { return success.month; }
    else if (orderType === 6) { return success.season; }
    else if (orderType === 7) { return success.year; }
  });
  /*const qrCode = await alipay_f2f.createQRPay({
    tradeNo: orderId,
    subject: orderSetting.orderName || 'ss续费',
    totalAmount: +amount,
    body: 'ss',
    timeExpress: 10,
  });*/
  const addr = jsjConfig.jsjGatewayUrl + '&addnum=' + orderId + '&total=' + amount + '&apiid=' + jsjConfig.apiid + '&apikey=' + md5(jsjConfig.apikey) + '&showurl=' + config.plugins.webgui.site + '/api/user/alipay/callback%3f';
  logger.info(addr);
  await knex('alipay').insert({
    orderId,
    orderType,
    qrcode: addr,
    amount: amount.toFixed(2) + '',
    user,
    account: account ? account : null,
    status: 'CREATE',
    createTime: Date.now(),
    expireTime: Date.now() + time * 60 * 1000,
  });
  logger.info(`创建订单: [${orderId}][${amount}][account: ${account}]`);
  return {
    orderId,
    qrCode: addr,
  };
};

const sendSuccessMail = async userId => {
  const emailPlugin = appRequire('plugins/email/index');
  const user = await knex('user').select().where({
    type: 'normal',
    id: userId,
  }).then(success => {
    if (success.length) {
      return success[0];
    }
    return Promise.reject('user not found');
  });
  const orderMail = await knex('webguiSetting').select().where({
    key: 'mail',
  }).then(success => {
    if (!success.length) {
      return Promise.reject('settings not found');
    }
    success[0].value = JSON.parse(success[0].value);
    return success[0].value.order;
  });
  await emailPlugin.sendMail(user.email, orderMail.title, orderMail.content);
};
/*
cron.minute(async () => {
  if (!alipay_f2f) { return; }
  const orders = await knex('alipay').select().whereNotBetween('expireTime', [0, Date.now()]);
  const scanOrder = order => {
    logger.info(`order: [${order.orderId}]`);
    if (order.status !== 'TRADE_SUCCESS' && order.status !== 'FINISH') {
      return alipay_f2f.checkInvoiceStatus(order.orderId).then(success => {
        if (success.code === '10000') {
          return knex('alipay').update({
            status: success.trade_status
          }).where({
            orderId: order.orderId,
          });
        }
      });
    } else if (order.status === 'TRADE_SUCCESS') {
      const accountId = order.account;
      const userId = order.user;
      push.pushMessage('支付成功', {
        body: `订单[ ${order.orderId} ][ ${order.amount} ]支付成功`,
      });
      return account.setAccountLimit(userId, accountId, order.orderType)
        .then(() => {
          return knex('alipay').update({
            status: 'FINISH',
          }).where({
            orderId: order.orderId,
          });
        }).then(() => {
          logger.info(`订单支付成功: [${order.orderId}][${order.amount}][account: ${accountId}]`);
          sendSuccessMail(userId);
        }).catch(err => {
          logger.error(`订单支付失败: [${order.orderId}]`, err);
        });
    };
  };
  for (const order of orders) {
    await scanOrder(order);
  }
}, 1);*/

cron.minute(async () => {
  if (!config.plugins.alipay || !config.plugins.alipay.use) { return; }
  const orders = await knex('alipay').select().whereNotBetween('expireTime', [0, Date.now()]);
  const scanOrder = order => {
    if (order.status !== 'approved' && order.status !== 'finish') {
      return checkOrder(order.orderId);
    } else if (order.status === 'approved') {
      const accountId = order.account;
      const userId = order.user;
      push.pushMessage('支付成功', {
        body: `订单[ ${order.orderId} ][ ${order.amount} ]支付成功`,
      });
      return checkOrder(order.orderId).then(() => {
        return account.setAccountLimit(userId, accountId, order.orderType);
      }).then(() => {
        return knex('alipay').update({
          status: 'finish',
        }).where({
          orderId: order.orderId,
        });
      }).then(() => {
        logger.info(`订单支付成功: [${order.orderId}][${order.amount}][account: ${accountId}]`);
        sendSuccessMail(userId);
      }).catch(err => {
        logger.error(`订单支付失败: [${order.orderId}]`, err);
      });
    };
  };
  for (const order of orders) {
    await scanOrder(order);
  }
}, 1);

const checkOrder = async (orderId) => {
  const order = await knex('alipay').select().where({
    orderId,
  }).then(success => {
    if (success.length) {
      return success[0];
    }
    return Promise.reject('order not found');
  });
  return order.status;
};

const verifyCallback = (data) => {
  logger.info(data);
  const signStatus = md5(jsjConfig.apikey + data.addnum) == data.apikey;
  if (signStatus) {
    knex('alipay').update({
      status: 'approved',
      alipayData: JSON.stringify(data),
    }).where({
      orderId: data.addnum,
      amount: data.total + ''
    }).andWhereNot({
      status: 'finish',
    }).then();
  }
  return signStatus;
};

const orderList = async (options = {}) => {
  const where = {};
  if (options.userId) {
    where['user.id'] = options.userId;
  }
  const orders = await knex('alipay').select([
    'alipay.orderId',
    'alipay.orderType',
    'user.id as userId',
    'user.username',
    'account_plugin.port',
    'alipay.amount',
    'alipay.status',
    'alipay.alipayData',
    'alipay.createTime',
    'alipay.expireTime',
  ])
    .leftJoin('user', 'user.id', 'alipay.user')
    .leftJoin('account_plugin', 'account_plugin.id', 'alipay.account')
    .where(where)
    .orderBy('alipay.createTime', 'DESC');
  orders.forEach(f => {
    f.alipayData = JSON.parse(f.alipayData);
  });
  return orders;
};

const orderListAndPaging = async (options = {}) => {
  const search = options.search || '';
  const filter = options.filter || [];
  const sort = options.sort || 'alipay.createTime_desc';
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;

  let count = knex('alipay').select();
  let orders = knex('alipay').select([
    'alipay.orderId',
    'alipay.orderType',
    'user.id as userId',
    'user.username',
    'account_plugin.port',
    'alipay.amount',
    'alipay.status',
    'alipay.alipayData',
    'alipay.createTime',
    'alipay.expireTime',
  ])
    .leftJoin('user', 'user.id', 'alipay.user')
    .leftJoin('account_plugin', 'account_plugin.id', 'alipay.account');

  if (filter.length) {
    count = count.whereIn('alipay.status', filter);
    orders = orders.whereIn('alipay.status', filter);
  }
  if (search) {
    count = count.where('alipay.orderId', 'like', `%${search}%`);
    orders = orders.where('alipay.orderId', 'like', `%${search}%`);
  }

  count = await count.count('orderId as count').then(success => success[0].count);
  orders = await orders.orderBy(sort.split('_')[0], sort.split('_')[1]).limit(pageSize).offset((page - 1) * pageSize);
  orders.forEach(f => {
    f.alipayData = JSON.parse(f.alipayData);
  });
  const maxPage = Math.ceil(count / pageSize);
  return {
    total: count,
    page,
    maxPage,
    pageSize,
    orders,
  };
};

cron.minute(() => {
  if (!config.plugins.alipay || !config.plugins.alipay.use) { return; }
  knex('alipay').delete().where({ status: 'CREATE' }).whereBetween('createTime', [0, Date.now() - 1 * 24 * 3600 * 1000]).then();
}, 37);

exports.orderListAndPaging = orderListAndPaging;
exports.orderList = orderList;
exports.createOrder = createOrder;
exports.checkOrder = checkOrder;
exports.verifyCallback = verifyCallback;
