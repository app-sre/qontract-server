const { createLogger, format, transports } = require('winston');

const {
  combine, timestamp, splat, printf,
} = format;

const logFormat = printf((info: any) => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`);

export const logger = createLogger({
  level: 'info',
  format: combine(timestamp(), splat(), logFormat),
  transports: [new transports.Console()],
});
