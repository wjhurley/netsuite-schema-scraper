import * as Winston from 'winston';

export const logger = Winston.createLogger({
    format: Winston.format.combine(
        Winston.format.colorize(),
        Winston.format.timestamp(),
        Winston.format.align(),
        Winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`),
    ),
    levels: Winston.config.cli.levels,
    transports: [
        new Winston.transports.Console(),
    ],
});
