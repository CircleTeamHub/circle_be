import { Test } from '@nestjs/testing';
// import { LogsService } from '../logs.service';

describe('LogsService', () => {
  // let service: LogsService;

  beforeEach(async () => {
    await Test.createTestingModule({
      // providers: [LogsService],
    }).compile();

    // service = module.get<LogsService>(LogsService);
  });

  it('should be defined', () => {
    // expect(service).toBeDefined();
  });
});
