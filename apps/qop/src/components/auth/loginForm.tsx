import * as z from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useStytch } from "@stytch/react";

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
import Spinner from "../spinner";
import { useState } from "react";

const formSchema = z.object({
  email: z.string().email(),
});
type FormSchemaType = z.infer<typeof formSchema>;

const LoginForm = (props: {
  changeState: (data: { email: string; methodId: string }) => void;
}) => {
  const stytch = useStytch();
  const form = useForm<FormSchemaType>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
    },
  });

  const [submitted, setSubmitted] = useState(false);

  const loginMutation = useMutation({
    mutationFn: async (vars: FormSchemaType) => {
      const res = await stytch.otps.email.loginOrCreate(vars.email);

      return { email: vars.email, methodId: res.method_id };
    },
    onSuccess: (data) => {
      props.changeState(data);
    },
    onError: (e) => {
      console.error("error while login", e);

      const reset = () => {
        setSubmitted(false);
        form.reset();
      };

      toast.error("Error while logging in", {
        onAutoClose: reset,
        onDismiss: reset,
      });
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
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
