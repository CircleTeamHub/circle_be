import { Test } from '@nestjs/testing';
// import { LogsController } from '../logs.controller';

describe('LogsController', () => {
  // let controller: LogsController;

  beforeEach(async () => {
    await Test.createTestingModule({
      // controllers: [LogsController],
    }).compile();

    // controller = module.get<LogsController>(LogsController);
  });

  it('should be defined', () => {
    // expect(controller).toBeDefined();
  });
});
