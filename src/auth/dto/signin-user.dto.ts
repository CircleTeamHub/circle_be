import { IsNotEmpty, IsString, Length } from 'class-validator';

export class SigninUserDto {
  @IsString()
  @IsNotEmpty()
  @Length(4, 32, {
    message: `账号长度必须在$constraint1到$constraint2之间，当前传递的值是：$value`,
  })
  accountId: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;
}
