import { CustomTransportStrategy, Server } from '@nestjs/microservices';
import {
  ConstructorOptions,
  RedisInstance,
  RedisStreamPattern,
  StreamResponse,
  StreamResponseObject,
} from './interfaces';

import { CONNECT_EVENT, ERROR_EVENT } from '@nestjs/microservices/constants';
import { Observable } from 'rxjs';
import { createRedisConnection } from './redis.utils';
import { RedisStreamContext } from './stream.context';
import { deserialize, serialize } from './streams.utils';

export class RedisStreamStrategy
  extends Server
  implements CustomTransportStrategy
{
  private streamHandlerMap = {};

  private redis: RedisInstance;

  private client: RedisInstance;

  constructor(private readonly options: ConstructorOptions) {
    super();
  }

  public listen(callback: () => void) {
    this.redis = createRedisConnection(this.options?.connection);
    this.client = createRedisConnection(this.options?.connection);

    // register instances for error handling.
    this.handleError(this.redis);
    this.handleError(this.client);

    // when server instance connect, bind handlers.
    this.redis.on(CONNECT_EVENT, () => {
      this.logger.log(
        'Redis connected successfully on ' +
          (this.options.connection?.url ??
            this.options.connection.host + ':' + this.options.connection.port),
      );

      this.bindHandlers();

      // Essential. or await app.listen() will hang forever.
      // Any code after it won't work.
      callback();
    });
  }

  public async bindHandlers() {
    try {
      // collect handlers from user-land, and register the streams.
      await Promise.all(
        Array.from(this.messageHandlers.keys()).map(async (pattern: string) => {
          await this.registerStream(pattern);
        }),
      );

      this.listenOnStreams();
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
  }

  private async registerStream(pattern: string) {
    try {
      let parsedPattern: RedisStreamPattern = JSON.parse(pattern);

      if (!parsedPattern.isRedisStreamHandler) return false;

      let { stream } = parsedPattern;

      this.streamHandlerMap[stream] = this.messageHandlers.get(pattern);

      await this.createConsumerGroup(
        stream,
        this.options?.streams?.consumerGroup,
      );

      return true;
    } catch (error) {
      // JSON.parse will throw error, if is not parsable.
      this.logger.debug(error + '. Handler Pattern is: ' + pattern);
      return false;
    }
  }

  private async createConsumerGroup(stream: string, consumerGroup: string) {
    try {
      await this.redis.xgroup('CREATE', stream, consumerGroup, '$', 'MKSTREAM');

      return true;
    } catch (error) {
      // if group exist for this stream. log debug.
      if (error?.message.includes('BUSYGROUP')) {
        this.logger.debug(
          'Consumer Group "' +
            consumerGroup +
            '" already exists for stream: ' +
            stream,
        );
        return true;
      } else {
        this.logger.error(error);
        return false;
      }
    }
  }

  private async publishResponses(
    responses: StreamResponseObject[],
    inboundContext: RedisStreamContext,
  ) {
    try {
      await Promise.all(
        responses.map(async (responseObj: StreamResponseObject) => {
          let serializedEntries: string[];

          // if custom serializer is provided.
          if (typeof this.options?.serialization?.serializer === 'function') {
            serializedEntries = await this.options.serialization.serializer(
              responseObj?.payload,
              inboundContext,
            );
          } else {
            serializedEntries = await serialize(
              responseObj?.payload,
              inboundContext,
            );
          }

          await this.client.xadd(responseObj.stream, '*', ...serializedEntries);
        }),
      );

      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  private async handleAck(inboundContext: RedisStreamContext) {
    try {
      await this.client.xack(
        inboundContext.getStream(),
        inboundContext.getConsumerGroup(),
        inboundContext.getMessageId(),
      );

      if (true === this.options?.streams?.deleteMessagesAfterAck) {
        await this.client.xdel(
          inboundContext.getStream(),
          inboundContext.getMessageId(),
        );
      }

      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  private async handleRespondBack({
    response,
    inboundContext,
    isDisposed,
  }: {
    response: StreamResponse;
    inboundContext: RedisStreamContext;
    isDisposed: boolean;
  }) {
    try {
      // if response is null or undefined, do not ACK, neither publish anything.
      if (!response) return;

      // if response is empty array, only ACK.
      if (Array.isArray(response) && response.length === 0) {
        await this.handleAck(inboundContext);
        return;
      }

      // otherwise, publish response, then Xack.
      if (Array.isArray(response) && response.length >= 1) {
        let publishedResponses = await this.publishResponses(
          response,
          inboundContext,
        );

        if (!publishedResponses) {
          throw new Error('Could not Xadd response streams.');
        }

        await this.handleAck(inboundContext);
      }
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async notifyHandlers(stream: string, messages: any[]) {
    try {
      const handler = this.streamHandlerMap[stream];

      await Promise.all(
        messages.map(async (message) => {
          let ctx = new RedisStreamContext([
            stream,
            message[0], // message id needed for ACK.
            this.options?.streams?.consumerGroup,
            this.options?.streams?.consumer,
          ]);

          let parsedPayload: any;

          // if custom deserializer is provided.
          if (typeof this.options?.serialization?.deserializer === 'function') {
            parsedPayload = await this.options.serialization.deserializer(
              message,
              ctx,
            );
          } else {
            parsedPayload = await deserialize(message, ctx);
          }

          // the staging function, should attach the inbound context to keep track of
          //  the message id for ACK, group name, stream name, etc.
          const stageRespondBack = (responseObj: any) => {
            responseObj.inboundContext = ctx;
            this.handleRespondBack(responseObj);
          };

          const response$ = this.transformToObservable(
            await handler(parsedPayload, ctx),
          ) as Observable<any>;

          response$ && this.send(response$, stageRespondBack);
        }),
      );
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async listenOnStreams() {
    try {
      let results: any[];

      results = await this.redis.xreadgroup(
        'GROUP',
        this.options?.streams?.consumerGroup || undefined,
        this.options?.streams?.consumer || undefined, // need to make it throw an error.
        'BLOCK',
        this.options?.streams?.block || 0,
        'STREAMS',
        ...(Object.keys(this.streamHandlerMap) as string[]), // streams keys
        ...(Object.keys(this.streamHandlerMap) as string[]).map(
          (stream: string) => '>',
        ), // '>', this is needed for xreadgroup as id.
      );

      // if BLOCK time ended, and results are null, listen again.
      if (!results) return this.listenOnStreams();

      for (let result of results) {
        let [stream, messages] = result;

        await this.notifyHandlers(stream, messages);
      }

      return this.listenOnStreams();
    } catch (error) {
      this.logger.error(error);
    }
  }

  // for redis instances. need to add mechanism to try to connect back.
  public handleError(stream: any) {
    stream.on(ERROR_EVENT, (err: any) => {
      this.logger.error('Redis instance error: ' + err);
      this.close();
    });
  }

  public close() {
    // shut down instances.
    this.redis && this.redis.quit();
    this.client && this.client.quit();
  }
}
