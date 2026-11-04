import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  SECURITY_ANSWER_MAX_LENGTH,
  SECURITY_QUESTION_COUNT,
  SECURITY_QUESTION_KEYS,
} from '../security-questions.service';

export class SecurityQuestionAnswerDto {
  @ApiProperty({ enum: SECURITY_QUESTION_KEYS, example: 'bestFriendName' })
  @IsIn(SECURITY_QUESTION_KEYS)
  questionKey: string;

  @ApiProperty({ example: '张三', maxLength: SECURITY_ANSWER_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SECURITY_ANSWER_MAX_LENGTH)
  answer: string;
}

export class SetSecurityQuestionsDto {
  @ApiProperty({ description: 'Current account password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @ApiProperty({ type: [SecurityQuestionAnswerDto] })
  @IsArray()
  @ArrayMinSize(SECURITY_QUESTION_COUNT)
  @ArrayMaxSize(SECURITY_QUESTION_COUNT)
  @ValidateNested({ each: true })
  @Type(() => SecurityQuestionAnswerDto)
  questions: SecurityQuestionAnswerDto[];
}

export class VerifySecurityQuestionsDto {
  @ApiProperty({
    type: [String],
    description: 'Answers in the order the questions were set',
  })
  @IsArray()
  @ArrayMinSize(SECURITY_QUESTION_COUNT)
  @ArrayMaxSize(SECURITY_QUESTION_COUNT)
  @IsString({ each: true })
  @MaxLength(SECURITY_ANSWER_MAX_LENGTH, { each: true })
  answers: string[];
}
