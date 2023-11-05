import * as z from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { NotFoundError } from "@teamhanko/hanko-frontend-sdk";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth";
import Spinner from "../spinner";
import { useState } from "react";

const formSchema = z.object({
  email: z.string().email(),
});
type FormSchemaType = z.infer<typeof formSchema>;

const LoginForm = (props: {
  changeState: (data: { email: string; userId: string }) => void;
}) => {
  const hanko = useAuth();
  const form = useForm<FormSchemaType>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
    },
  });

  const [submitted, setSubmitted] = useState(false);

  const loginMutation = useMutation({
    mutationFn: async (vars: FormSchemaType) => {
      let userId: string;

      const user = await hanko.user.getInfo(vars.email).catch((e) => {
        if (e instanceof NotFoundError) return null;
        throw e;
      });

      if (!user) {
        const newUser = await hanko.user.create(vars.email);
        userId = newUser.user_id;
      } else userId = user.id;

      await hanko.passcode.initialize(userId, vars.email);
      return { email: vars.email, userId };
    },
    onSuccess: (data) => {
      props.changeState(data);
    },
    onError: (e) => {
      console.log(e);
    },
  });

  // 2. Define a submit handler.
  function onSubmit(values: FormSchemaType) {
    setSubmitted(true);
    // Do something with the form values.
    // ✅ This will be type-safe and validated.
    loginMutation.mutate(values);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="bruhh@qop.sh" {...field} />
              </FormControl>
              <FormDescription>Email Address</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={submitted}>
          {submitted ? <Spinner /> : "Submit"}
        </Button>
      </form>
    </Form>
  );
};

export default LoginForm;
